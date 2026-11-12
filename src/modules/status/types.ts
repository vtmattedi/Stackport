/**
 * The live status stream's data model (protocol version 1).
 *
 * Everything here is built field by field from the app's own state; nothing is a database row passed through, so a field added to a table
 * later does not appear on the stream by itself. A string that came from a person (a project name, a group) is cut and stripped by
 * `clean`. Env values, logs, paths, hostnames, commit messages and credentials are never part of it.
 */

export const STATUS_PROTOCOL_VERSION = 1;

/** The sections a snapshot has, and an `update` message carries one of. */
export const STATUS_SECTIONS = ["host", "projects", "actions", "alerts"] as const;
export type StatusSection = (typeof STATUS_SECTIONS)[number];

export interface HostStatus {
  cpuPercent: number;
  memPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  load1: number;
  /** Docker's data disk. */
  diskUsedPct: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  sampledAt: string;
}

export type ProjectState = "ready" | "problem" | "down" | "not-deployed" | "paused";

export interface ProjectRequestStats {
  /** The length of the window the numbers cover, in seconds. */
  windowS: number;
  requests: number;
  serverErrors: number;
  /** 5xx share of the requests in the window, 0 to 100; null when there were none. */
  errorRatePct: number | null;
  p95Ms: number | null;
}

export interface ProjectStatus {
  id: number;
  name: string;
  group: string | null;
  state: ProjectState;
  containers: { running: number; total: number };
  /** `none` when no health check is configured, `unknown` before the first check has run. */
  health: "ok" | "failing" | "unknown" | "none";
  lastCheckedAt: string | null;
  /** From the proxy's access log; null until it has been read, or when Nginx is not running. */
  traffic: ProjectRequestStats | null;
}

export interface ActionStatus {
  id: string;
  kind: string;
  projectId: number | null;
  projectName: string | null;
  startedAt: string;
  /** 0 to 100 for actions that report a build estimate; null otherwise. */
  progress: number | null;
}

export type AlertSeverity = "warning" | "critical";

/** Something is wrong with X, now. It is a condition, not an event: it is in the list while it holds and gone when it stops. */
export interface Alert {
  /** Stable for as long as the condition lasts (`code:subject`), so an adapter can tell a new alert from the same one again. */
  id: string;
  severity: AlertSeverity;
  code: AlertCode;
  scope: "host" | "project";
  /** Present for a project alert. */
  projectId: number | null;
  subject: string;
  /** A fixed sentence about the subject; it never carries command output. */
  message: string;
  /** When Stackport first saw the condition (resets if Stackport restarts). */
  since: string;
  /** The measured value for threshold alerts. */
  value: number | null;
  unit: "%" | "ms" | null;
}

export const ALERT_CODES = [
  "project_down", "project_unhealthy", "project_deploy_failed", "project_error_rate", "project_latency",
  "host_disk_low", "host_docker_down", "host_nginx_down",
] as const;
export type AlertCode = (typeof ALERT_CODES)[number];

export interface StatusSnapshot {
  host: HostStatus | null;
  projects: ProjectStatus[];
  actions: ActionStatus[];
  alerts: Alert[];
}

/** Server to client messages. The client sends nothing the server acts on (see the transport). */
export type StatusMessage =
  | { type: "hello"; v: typeof STATUS_PROTOCOL_VERSION; instance: string; sections: StatusSection[]; scope: "all" | "group" }
  | { type: "snapshot"; v: typeof STATUS_PROTOCOL_VERSION; seq: number; at: string; data: StatusSnapshot }
  | { type: "update"; v: typeof STATUS_PROTOCOL_VERSION; seq: number; at: string; section: StatusSection; data: StatusSnapshot[StatusSection] }
  /** `dataAgeS` is how old the data behind the stream is. A heartbeat only proves the connection; a rising age proves the collector is failing. */
  | { type: "heartbeat"; v: typeof STATUS_PROTOCOL_VERSION; seq: number; at: string; dataAgeS: number | null };

/** A string from a person, safe to put on the wire: control characters removed, cut to `max` characters. */
export function clean(value: string, max = 80): string {
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

/** A number from a measurement, or null when it is not a finite number; rounded so the stream is not noisy. */
export function finite(value: number | null | undefined, digits = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
