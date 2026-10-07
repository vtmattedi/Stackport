import { getDatabase } from "../config/database";
import { auditLog } from "../utils/logger";
import { rowToProject, type ProjectRow } from "../entities/Project";
import { notifyHealthCheckFailure } from "./notificationService";
import { getProjectHealthCheckDomain } from "./projectDomains";

const MIN_INTERVAL_S = 30;

// Tags outbound health-check requests so nginx metrics can identify and
// exclude this self-generated traffic reliably — the server's own public IP
// isn't always known (see getServerIps() in routes/metrics.ts), but the UA is.
export const HEALTH_CHECK_USER_AGENT = "Stackport-HealthCheck/1.0";

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
    const domain = row ? getProjectHealthCheckDomain(id, row.health_check_domain_id) : null;
    if (!row || !domain || !row.health_check_endpoint || row.paused) return;

    const url = `https://${domain.domain}${row.health_check_endpoint}`;

    const start = Date.now();
    let status: "up" | "down" = "down";
    let responseMs: number | null = null;

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": HEALTH_CHECK_USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      responseMs = Date.now() - start;
      status = response.ok ? "up" : "down";
    } catch {
      status = "down";
    }

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
