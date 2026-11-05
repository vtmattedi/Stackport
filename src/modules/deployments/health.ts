import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { randomUUID } from "crypto";
import { rowToProject, type ProjectRow } from "../projects/types";
import { enqueueNotificationTx, sendNotificationEmail } from "../notifications/operations";
import { healthFailureEvent } from "../notifications/events";
import { cancelEvent } from "../notifications/push/outbox";
import type { StackportNotification } from "../notifications/types";
import { getProjectHealthCheckDomain } from "../ingress/domains";

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

export class HealthChecker {
  private timers = new Map<number, NodeJS.Timeout>();
  private inFlight = new Set<number>();

  constructor(private readonly probe = probeHealth) {}

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
    const timer = setInterval(() => void this.check(project.id).catch(() => logger.error({ projectId: project.id }, "health-check.commit-failed")), ms);
    this.timers.set(project.id, timer);
  }

  unschedule(id: number): void {
    const t = this.timers.get(id);
    if (t) { clearInterval(t); this.timers.delete(id); }
  }

  async check(id: number): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try { await this.checkOnce(id); }
    finally { this.inFlight.delete(id); }
  }

  private async checkOnce(id: number): Promise<void> {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    const url = row ? healthCheckUrl(row) : null;
    if (!row || !url) return;

    // A monotonic DB ticket orders overlapping probes even if two processes start
    // in the same millisecond. No transaction is held during the HTTP probe.
    const started = db.transaction(() => {
      const current = db.prepare("SELECT health_probe_started_at_ms FROM projects WHERE id=?").get(id) as { health_probe_started_at_ms: number } | undefined;
      if (!current) return null;
      const ticket = Math.max(Date.now(), current.health_probe_started_at_ms + 1);
      db.prepare("UPDATE projects SET health_probe_started_at_ms=? WHERE id=?").run(ticket, id);
      return ticket;
    }).immediate();
    if (started === null) return;
    const { status, responseMs } = await this.probe(url);

    const now = new Date().toISOString();
    const transition = db.transaction((): { event?: StackportNotification; name: string } | null => {
      const current = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as (ProjectRow & { health_incident_key: string | null; health_probe_started_at_ms: number }) | undefined;
      if (!current || healthCheckUrl(current) !== url || current.health_probe_started_at_ms !== started) return null;
      let incident = current.health_incident_key;
      let event: StackportNotification | undefined;
      if (status === "down" && current.last_status !== "down") {
        incident = `health_check:${id}:${randomUUID()}`;
        event = healthFailureEvent(current.name, url, responseMs, id, incident, now);
        enqueueNotificationTx(db, event);
      } else if (status === "up" && incident) {
        cancelEvent(db, incident, "health_incident_resolved");
        incident = null;
      }
      db.prepare(`UPDATE projects SET last_status=?, last_response_ms=?, last_checked_at=?, updated_at=?,
        health_incident_key=?, health_probe_started_at_ms=? WHERE id=?`).run(status, responseMs, now, now, incident, started, id);
      return { event, name: current.name };
    }).immediate();
    if (!transition) return;

    auditLog("system", "project.health-check", transition.name, status === "up" ? "ok" : "fail", {
      responseMs,
      url,
    });

    if (transition.event) void sendNotificationEmail(transition.event);
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}

export const healthChecker = new HealthChecker();
