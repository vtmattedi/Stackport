import { statusHub } from "../status/hub";
import type { Alert, StatusSnapshot } from "../status/types";
import { hasGrant, type Grant } from "./grants";

/**
 * What this instance reports about itself to a controller, and what a controller keeps of what a peer reported.
 *
 * The managed side reuses the live status stream's snapshot (host, projects, actions, alerts), so there is one source of these numbers. What a
 * controller receives depends on its grants: `host:read` for the machine (and the alerts about it), `projects:read` for projects, their
 * actions and their alerts. A controller with neither gets nothing.
 */

export interface PeerStatusReport extends StatusSnapshot {
  /** How old the data is on the reporting instance, in seconds. */
  ageSeconds: number | null;
}

export async function reportStatus(grants: readonly Grant[]): Promise<PeerStatusReport> {
  const snapshot = await statusHub.current();
  const host = hasGrant(grants, "host:read");
  const projects = hasGrant(grants, "projects:read");
  const keep = (alert: Alert): boolean => (alert.scope === "host" ? host : projects);
  return {
    host: host ? snapshot.host : null,
    projects: projects ? snapshot.projects : [],
    actions: projects ? snapshot.actions : [],
    alerts: snapshot.alerts.filter(keep),
    ageSeconds: statusHub.ageSeconds(),
  };
}

/** A peer's answer is the peer's: a different version or a misbehaving server may send something else. Checked before it is cached or summarised. */
export function isStatusReport(value: unknown): value is PeerStatusReport {
  if (value === null || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  const rows = (list: unknown, ok: (row: Record<string, unknown>) => boolean): boolean => Array.isArray(list) && list.every((row) => row !== null && typeof row === "object" && ok(row as Record<string, unknown>));
  return (report["host"] === null || (typeof report["host"] === "object" && typeof (report["host"] as Record<string, unknown>)["cpuPercent"] === "number"))
    && rows(report["projects"], (row) => typeof row["state"] === "string")
    && rows(report["actions"], () => true)
    && rows(report["alerts"], (row) => typeof row["severity"] === "string" && (row["scope"] === "host" || row["scope"] === "project"));
}

/** A few numbers per instance for a list or a sidebar dot, so a page does not have to carry (or interpret) the whole snapshot. */
export interface StatusSummary {
  host: StatusSnapshot["host"];
  projects: { total: number; ready: number; problem: number; down: number; notDeployed: number; paused: number };
  runningActions: number;
  alerts: { total: number; critical: number };
}

export function summarize(report: Pick<StatusSnapshot, "host" | "projects" | "actions" | "alerts">): StatusSummary {
  const count = (state: string): number => report.projects.filter((project) => project.state === state).length;
  return {
    host: report.host,
    projects: { total: report.projects.length, ready: count("ready"), problem: count("problem"), down: count("down"), notDeployed: count("not-deployed"), paused: count("paused") },
    runningActions: report.actions.length,
    alerts: { total: report.alerts.length, critical: report.alerts.filter((alert) => alert.severity === "critical").length },
  };
}
