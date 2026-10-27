import { getDatabase } from "../config/database";
import { auditLog } from "../utils/logger";
import { rowToProject, type ProjectRow } from "../entities/Project";
import { notifyHealthCheckFailure } from "./notificationService";
import { getProjectHealthCheckDomain } from "./projectDomains";

const MIN_INTERVAL_S = 30;
const PROBE_TIMEOUT_MS = 10_000;

// Tags outbound health-check requests so nginx metrics can identify and
// exclude this self-generated traffic reliably — the server's own public IP
// isn't always known (see getServerIps() in routes/metrics.ts), but the UA is.
export const HEALTH_CHECK_USER_AGENT = "Stackport-HealthCheck/1.0";

interface HealthTargetRow {
  id: number;
  paused: number;
  health_check_endpoint: string | null;
  health_check_domain_id: number | null;
}

/** The URL a project's health check fetches, or null when it has none (no endpoint, no
 *  domain, or paused). Periodic monitoring additionally needs an interval (schedule);
 *  "Check now" and the post-deploy check (verifyDeployHealth) don't. */
export function healthCheckUrl(row: HealthTargetRow): string | null {
  if (row.paused || !row.health_check_endpoint) return null;
  const domain = getProjectHealthCheckDomain(row.id, row.health_check_domain_id);
  if (!domain) return null;
  return `${domain.useSsl ? "https" : "http"}://${domain.domain}${row.health_check_endpoint}`;
}

export interface HealthProbe {
  status: "up" | "down";
  responseMs: number | null;
}

export async function probeHealth(url: string): Promise<HealthProbe> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": HEALTH_CHECK_USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { status: response.ok ? "up" : "down", responseMs: Date.now() - start };
  } catch {
    return { status: "down", responseMs: null };
  }
}

class HealthChecker {
  private timers = new Map<number, NodeJS.Timeout>();

  start(): void {
    const rows = getDatabase()
      .prepare(
        `SELECT p.* FROM projects p
         WHERE p.paused = 0 AND p.health_check_interval_s >= ? AND p.health_check_endpoint IS NOT NULL
           AND EXISTS (SELECT 1 FROM project_domains pd WHERE pd.project_id = p.id)`
      )
      .all(MIN_INTERVAL_S) as ProjectRow[];

    for (const row of rows) {
      this.schedule(rowToProject(row));
    }
  }

  /** Checks one explicitly selected domain per project, independent of routing. */
  schedule(project: { id: number; healthCheckDomainId: number | null; healthCheckEndpoint: string | null; healthCheckIntervalS: number; paused?: boolean }): void {
    this.unschedule(project.id);
    if (project.paused) return;
    const domain = getProjectHealthCheckDomain(project.id, project.healthCheckDomainId);
    if (!domain || !project.healthCheckEndpoint || project.healthCheckIntervalS < MIN_INTERVAL_S) return;
    const ms = project.healthCheckIntervalS * 1000;
    const timer = setInterval(() => void this.check(project.id), ms);
    this.timers.set(project.id, timer);
  }

  unschedule(id: number): void {
    const t = this.timers.get(id);
    if (t) { clearInterval(t); this.timers.delete(id); }
  }

  async check(id: number): Promise<void> {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    const url = row ? healthCheckUrl(row) : null;
    if (!row || !url) return;

    const { status, responseMs } = await probeHealth(url);

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE projects SET last_status = ?, last_response_ms = ?, last_checked_at = ?, updated_at = ? WHERE id = ?"
    ).run(status, responseMs, now, now, id);

    auditLog("system", "project.health-check", row.name, status === "up" ? "ok" : "fail", {
      responseMs,
      url,
    });

    if (status === "down" && row.last_status !== "down") {
      void notifyHealthCheckFailure(row.name, url, responseMs);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}

export const healthChecker = new HealthChecker();
