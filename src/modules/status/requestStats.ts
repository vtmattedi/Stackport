import { execFile } from "child_process";
import { getDatabase } from "../../config/database";
import { SingleFlightCache } from "../../shared/singleFlightCache";
import { HEALTH_CHECK_USER_AGENT } from "../deployments/health";
import { parseNginxLine } from "../observability/routes/metrics";
import type { ProjectRequestStats } from "./types";
import { finite } from "./types";

/**
 * p95 response time and 5xx share per project, over the last few minutes of the proxy's access log.
 *
 * The web UI computes the same kind of numbers for a day or more, on request. A stream needs them now and often, so this reads a short window
 * (`WINDOW_MS`) at most every `TTL_MS`, however many consumers there are (SingleFlightCache), and only when somebody is connected.
 * Stackport's own health-check requests are left out: they would hold the 5xx share down while a project is failing.
 */

export const WINDOW_MS = 5 * 60_000;
const TTL_MS = 30_000;
const LINE_CAP = 20_000;
/** Fewer requests than this and a percentage or a percentile is noise: the alert rules ignore it, and so should a reader. */
export const MIN_REQUESTS = 20;

export interface LoggedRequest {
  date: Date | null;
  status: number;
  host: string | null;
  requestTimeMs: number | null;
  ua: string | null;
}

/** Nearest-rank percentile of a list of numbers; null when it is empty. */
export function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((pct / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/** `Shop.Example.com:443` to `shop.example.com`. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * The requests in the window, counted per project. `hostToProject` says which project a hostname serves; a request for any other host
 * (Stackport itself, a hostname nobody owns, a scanner) belongs to no project and is dropped.
 */
export function summarizeRequests(requests: LoggedRequest[], hostToProject: Map<string, number>, now: number, windowMs = WINDOW_MS): Map<number, ProjectRequestStats> {
  const start = now - windowMs;
  const byProject = new Map<number, { count: number; serverErrors: number; times: number[] }>();
  for (const request of requests) {
    if (!request.date || request.date.getTime() < start || request.date.getTime() > now + 60_000) continue;
    if (request.ua === HEALTH_CHECK_USER_AGENT || !request.host) continue;
    const projectId = hostToProject.get(normalizeHost(request.host));
    if (projectId === undefined) continue;
    const entry = byProject.get(projectId) ?? { count: 0, serverErrors: 0, times: [] };
    entry.count += 1;
    if (request.status >= 500 && request.status <= 599) entry.serverErrors += 1;
    if (request.requestTimeMs !== null && Number.isFinite(request.requestTimeMs) && request.requestTimeMs >= 0) entry.times.push(request.requestTimeMs);
    byProject.set(projectId, entry);
  }
  const out = new Map<number, ProjectRequestStats>();
  for (const [projectId, entry] of byProject) {
    out.set(projectId, {
      windowS: Math.round(windowMs / 1000),
      requests: entry.count,
      serverErrors: entry.serverErrors,
      errorRatePct: entry.count > 0 ? finite((entry.serverErrors / entry.count) * 100, 2) : null,
      p95Ms: percentile(entry.times, 95),
    });
  }
  return out;
}

function hostnameOwners(): Map<string, number> {
  const rows = getDatabase().prepare("SELECT lower(domain) AS domain, project_id FROM project_domains").all() as { domain: string; project_id: number }[];
  return new Map(rows.map((row) => [row.domain, row.project_id]));
}

function readAccessLog(): Promise<string | null> {
  return new Promise((resolve) => {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    execFile("docker", ["logs", "--since", since, "--tail", String(LINE_CAP), "stackport-nginx"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

const cache = new SingleFlightCache<Map<number, ProjectRequestStats> | null>(async () => {
  const text = await readAccessLog();
  if (text === null) return null;
  const requests: LoggedRequest[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const entry = parseNginxLine(line);
    if (entry) requests.push({ date: entry.date, status: entry.status, host: entry.host, requestTimeMs: entry.requestTimeMs, ua: entry.ua });
  }
  return summarizeRequests(requests, hostnameOwners(), Date.now());
}, TTL_MS);

/** Per-project numbers for the last few minutes; null when the access log could not be read (Nginx down, Docker unavailable). */
export function projectTraffic(): Promise<Map<number, ProjectRequestStats> | null> {
  return cache.get();
}
