import type { NginxDomainStat, NginxLogEntry, NginxMetrics, NginxTimePoint } from "../../api/types";
import { STATUS_COLORS } from "./shared";

/** Size of the recent-request sample the log inspector and anomaly rules work on. */
export const LOG_LIMIT = 500;

// ── Anomaly rules ────────────────────────────────────────────────────────
export const RULES = [
  { id: "secret_path", label: "Secret / admin path probe", sev: "high", desc: ".env, .git, .aws, wp-admin, phpmyadmin, config files" },
  { id: "injection", label: "Injection signatures", sev: "high", desc: "SQLi / traversal / XSS patterns in the path or query" },
  { id: "error_response", label: "Error response (5xx)", sev: "high", desc: "502/504 usually mean nginx couldn't reach the app; other 5xx usually mean the app itself errored" },
  { id: "scanner_ua", label: "Scanner user-agents", sev: "med", desc: "sqlmap, nmap, nikto, zgrab and similar tools" },
  { id: "bad_method", label: "Malformed / unusual method", sev: "med", desc: "TRACE, CONNECT or a garbage verb" },
  { id: "empty_ua", label: "Missing user-agent", sev: "low", desc: "Empty or absent user-agent header" },
] as const;

export type RuleId = typeof RULES[number]["id"];
export type Severity = "high" | "med" | "low";
export interface Flag { ruleId: RuleId; label: string; sev: Severity }

export const DEFAULT_RULES = Object.fromEntries(RULES.map((r) => [r.id, true])) as Record<RuleId, boolean>;

const SECRET_PATH_RE = /\.env|\.git|\.aws|\.ssh|wp-admin|wp-login|phpmyadmin|\.htpasswd|config\.php/;
const INJECTION_RE = /union|select|<script|%3cscript|\.\.\/|%2e%2e|\/etc\/passwd|%20or%20|'\s?or\s?'/;
const SCANNER_UA_RE = /sqlmap|nmap|nikto|zgrab|nuclei|dirbuster|masscan|python-requests|curl\/|libwww-perl/;
const COMMON_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];

export function flagsFor(entry: NginxLogEntry, rules: Record<RuleId, boolean>): Flag[] {
  const flags: Flag[] = [];
  const p = (entry.path || "").toLowerCase();
  const ua = (entry.ua || "").toLowerCase();
  if (rules.secret_path && SECRET_PATH_RE.test(p)) flags.push({ ruleId: "secret_path", label: "Secret path", sev: "high" });
  if (rules.injection && INJECTION_RE.test(p)) flags.push({ ruleId: "injection", label: "Injection", sev: "high" });
  if (rules.error_response && entry.status >= 500) flags.push({ ruleId: "error_response", label: `Error ${entry.status}`, sev: "high" });
  if (rules.scanner_ua && SCANNER_UA_RE.test(ua)) flags.push({ ruleId: "scanner_ua", label: "Scanner UA", sev: "med" });
  if (rules.bad_method && !COMMON_METHODS.includes(entry.method)) flags.push({ ruleId: "bad_method", label: "Bad method", sev: "med" });
  if (rules.empty_ua && (!entry.ua || entry.ua === "-")) flags.push({ ruleId: "empty_ua", label: "No UA", sev: "low" });
  return flags;
}

export function severityVariant(sev: Severity): "destructive" | "secondary" | "outline" {
  if (sev === "high") return "destructive";
  if (sev === "med") return "secondary";
  return "outline";
}

// ── Status helpers ───────────────────────────────────────────────────────
export function statusColor(status: number): string {
  if (status >= 500) return "var(--danger)";
  if (status >= 400) return "#f0b429";
  if (status >= 300) return "var(--brand)";
  return "var(--success)";
}

export function maskIp(ip: string, mask: boolean): string {
  return mask ? ip.replace(/\.\d+$/, ".xxx").replace(/:[0-9a-f]*:[0-9a-f]*$/i, ":xxxx:xxxx") : ip;
}

export function statusClasses(codes: Record<string, number>): Array<{ name: keyof typeof STATUS_COLORS; value: number; color: string }> {
  const groups = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  for (const [code, count] of Object.entries(codes)) {
    const key = `${code[0]}xx` as keyof typeof groups;
    if (key in groups) groups[key] += count;
  }
  return (Object.keys(groups) as Array<keyof typeof groups>).map((name) => ({ name, value: groups[name], color: STATUS_COLORS[name] }));
}

export function statusRates(codes: Record<string, number> | undefined): { rate4xx: number; rate5xx: number; count5xx: number; total: number } {
  let c4 = 0, c5 = 0, total = 0;
  for (const [code, count] of Object.entries(codes ?? {})) {
    total += count;
    if (code[0] === "4") c4 += count;
    else if (code[0] === "5") c5 += count;
  }
  return { rate4xx: total ? (c4 / total) * 100 : 0, rate5xx: total ? (c5 / total) * 100 : 0, count5xx: c5, total };
}

// ── Scoped totals ────────────────────────────────────────────────────────
export interface TrafficTotals {
  requests: number;
  bytes: number;
  statusCodes: Record<string, number>;
  timeSeries: NginxTimePoint[];
  /** Exact for all traffic; summed per host when scoped, so a visitor of two projects counts twice. */
  uniqueIps: number | null;
  botRequests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** True when p50/p95 are request-weighted per-host values rather than exact percentiles. */
  approxLatency: boolean;
  topPaths: Array<{ path: string; count: number }>;
  domains: NginxDomainStat[];
}

/** Whole-server numbers when `hosts` is null, otherwise the selected hosts merged together. */
export function trafficTotals(nginx: NginxMetrics | null, hosts: Set<string> | null): TrafficTotals {
  const allDomains = nginx?.domains ?? [];
  if (!hosts) {
    return {
      requests: nginx?.totalRequests ?? 0,
      bytes: nginx?.bytesTotal ?? 0,
      statusCodes: nginx?.statusCodes ?? {},
      timeSeries: nginx?.timeSeries ?? [],
      uniqueIps: nginx?.uniqueIps ?? null,
      botRequests: nginx?.botRequests ?? 0,
      p50Ms: nginx?.p50ResponseMs ?? null,
      p95Ms: nginx?.p95ResponseMs ?? null,
      approxLatency: false,
      topPaths: nginx?.topPaths ?? [],
      domains: allDomains,
    };
  }

  const domains = allDomains.filter((d) => hosts.has(d.host.toLowerCase()));
  const statusCodes: Record<string, number> = {};
  const paths = new Map<string, number>();
  for (const d of domains) {
    for (const [code, count] of Object.entries(d.statusCodes)) statusCodes[code] = (statusCodes[code] ?? 0) + count;
    for (const p of d.topPaths) paths.set(p.path, (paths.get(p.path) ?? 0) + p.count);
  }
  const base = domains[0]?.timeSeries ?? nginx?.timeSeries?.map((pt) => ({ ...pt, count: 0, errors: 0, serverErrors: 0 })) ?? [];
  const timeSeries = base.map((pt, i) => ({
    ts: pt.ts,
    count: domains.reduce((s, d) => s + (d.timeSeries[i]?.count ?? 0), 0),
    errors: domains.reduce((s, d) => s + (d.timeSeries[i]?.errors ?? 0), 0),
    serverErrors: domains.reduce((s, d) => s + (d.timeSeries[i]?.serverErrors ?? 0), 0),
  }));
  const weighted = (pick: (d: NginxDomainStat) => number | null) => {
    const withRt = domains.filter((d) => pick(d) != null);
    const req = withRt.reduce((s, d) => s + d.requests, 0);
    return req ? Math.round(withRt.reduce((s, d) => s + (pick(d) ?? 0) * d.requests, 0) / req) : null;
  };

  return {
    requests: domains.reduce((s, d) => s + d.requests, 0),
    bytes: domains.reduce((s, d) => s + d.bytes, 0),
    statusCodes,
    timeSeries,
    uniqueIps: domains.reduce((s, d) => s + (d.uniqueIps ?? 0), 0),
    botRequests: domains.reduce((s, d) => s + (d.botRequests ?? 0), 0),
    p50Ms: domains.length === 1 ? domains[0].p50ResponseMs : weighted((d) => d.p50ResponseMs),
    p95Ms: domains.length === 1 ? domains[0].p95ResponseMs : weighted((d) => d.p95ResponseMs),
    approxLatency: domains.length > 1,
    topPaths: Array.from(paths.entries()).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    domains,
  };
}

/** Splits each bucket into 2xx-3xx / 4xx / 5xx for the stacked requests chart. */
export function splitSeries(series: NginxTimePoint[]) {
  return series.map((pt) => {
    const server = pt.serverErrors ?? 0;
    const client = Math.max(0, pt.errors - server);
    return { ts: pt.ts, ok: Math.max(0, pt.count - pt.errors), client, server };
  });
}
