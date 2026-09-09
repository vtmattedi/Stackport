import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Radar, RefreshCw, Loader, AlertCircle, ChevronRight, Search, Eye, EyeOff,
  Settings, X, Copy, Filter, Clock, ShieldAlert, Globe,
} from "lucide-react";
import { Squircle } from "lucide-react";
import {
  LineChart, Line, PieChart, Pie, Cell, CartesianGrid, XAxis, YAxis,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { api } from "../api/client";
import type { NginxMetrics, NginxDomainStat, NginxLogEntry, NginxLogEntriesResult } from "../api/types";
import { CHART_TICK, CHART_GRID_COLOR, CHART_TOOLTIP_STYLE } from "../lib/charts";
import { useSystem } from "../context/SystemContext";
import { notify } from "../lib/notify";
import { cn } from "../lib/utils";
import { AppSelect } from "../components/AppSelect";
import { MultiSelect, multiSelectSummary } from "../components/MultiSelect";
import { Switch } from "../components/ui/switch";
import { Badge } from "../components/ui/badge";
import { ExpandableCard } from "../components/ExpandableCard";
import { StatusChip } from "../components/StatusChip";
import styles from "./Traffic.module.scss";

const PERIOD_OPTIONS = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

const LOG_LIMIT = 500;

// ── Anomaly rules ────────────────────────────────────────────────────────
const RULES = [
  { id: "secret_path", label: "Secret / admin path probe", sev: "high", desc: ".env, .git, .aws, wp-admin, phpmyadmin, config files" },
  { id: "injection", label: "Injection signatures", sev: "high", desc: "SQLi / traversal / XSS patterns in the path or query" },
  { id: "error_response", label: "Error response (5xx)", sev: "high", desc: "502/504 usually mean nginx couldn't reach the app; other 5xx usually mean the app itself errored" },
  { id: "scanner_ua", label: "Scanner user-agents", sev: "med", desc: "sqlmap, nmap, nikto, zgrab and similar tools" },
  { id: "bad_method", label: "Malformed / unusual method", sev: "med", desc: "TRACE, CONNECT or a garbage verb" },
  { id: "empty_ua", label: "Missing user-agent", sev: "low", desc: "Empty or absent user-agent header" },
] as const;

type RuleId = typeof RULES[number]["id"];
type Severity = "high" | "med" | "low";

interface Flag { ruleId: RuleId; label: string; sev: Severity; }

const SECRET_PATH_RE = /\.env|\.git|\.aws|\.ssh|wp-admin|wp-login|phpmyadmin|\.htpasswd|config\.php/;
const INJECTION_RE = /union|select|<script|%3cscript|\.\.\/|%2e%2e|\/etc\/passwd|%20or%20|'\s?or\s?'/;
const SCANNER_UA_RE = /sqlmap|nmap|nikto|zgrab|nuclei|dirbuster|masscan|python-requests|curl\/|libwww-perl/;
const COMMON_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];

function flagsFor(entry: NginxLogEntry, rules: Record<RuleId, boolean>): Flag[] {
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

const COLUMNS = [
  { id: "s5", label: "5xx count" },
  { id: "err", label: "4xx rate" },
  { id: "rt", label: "Avg RT" },
  { id: "bw", label: "Egress" },
  { id: "flags", label: "Flags" },
] as const;

type ColumnId = typeof COLUMNS[number]["id"];

const DEFAULT_RULES = Object.fromEntries(RULES.map((r) => [r.id, true])) as Record<RuleId, boolean>;
const DEFAULT_COLUMNS = Object.fromEntries(COLUMNS.map((c) => [c.id, true])) as Record<ColumnId, boolean>;

const RECOMMENDED_LOG_FORMAT = `log_format stackport '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" "$host" $request_time';`;

function useLocalStorageState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }, [key, state]);
  return [state, setState];
}

// ── Formatters ───────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatHour(hour: string): string {
  const m = hour.match(/T(\d{2})/);
  return m ? `${m[1]}h` : hour;
}

function formatDate(date: string): string {
  const d = new Date(date);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function maskIp(ip: string, mask: boolean): string {
  return mask ? ip.replace(/\.\d+$/, ".xxx") : ip;
}

function statusColor(status: number): string {
  if (status >= 500) return "var(--danger)";
  if (status >= 400) return "#f0b429";
  if (status >= 300) return "var(--brand)";
  return "var(--success)";
}

function severityVariant(sev: Severity): "destructive" | "secondary" | "outline" {
  if (sev === "high") return "destructive";
  if (sev === "med") return "secondary";
  return "outline";
}

function groupStatusCodes(codes: Record<string, number>): Array<{ name: string; value: number; color: string }> {
  const groups: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  for (const [code, count] of Object.entries(codes)) {
    const prefix = code[0];
    if (prefix === "2") groups["2xx"] += count;
    else if (prefix === "3") groups["3xx"] += count;
    else if (prefix === "4") groups["4xx"] += count;
    else if (prefix === "5") groups["5xx"] += count;
  }
  const COLOR: Record<string, string> = { "2xx": "#3fb950", "3xx": "#6366f1", "4xx": "#f0b429", "5xx": "#f85149" };
  return Object.entries(groups).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value, color: COLOR[name] ?? "#7d8590" }));
}

function statusSplit(codes: Record<string, number> | undefined): { rate4xx: number; rate5xx: number; total: number } {
  if (!codes) return { rate4xx: 0, rate5xx: 0, total: 0 };
  let c4 = 0, c5 = 0, total = 0;
  for (const [code, count] of Object.entries(codes)) {
    total += count;
    if (code[0] === "4") c4 += count;
    else if (code[0] === "5") c5 += count;
  }
  return { rate4xx: total > 0 ? (c4 / total) * 100 : 0, rate5xx: total > 0 ? (c5 / total) * 100 : 0, total };
}

// ── Multi-domain aggregation (used when 1+ specific projects are selected) ──
function mergeStatusCodes(domains: NginxDomainStat[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of domains) {
    for (const [code, count] of Object.entries(d.statusCodes)) out[code] = (out[code] ?? 0) + count;
  }
  return out;
}

function mergeTimeSeries(domains: NginxDomainStat[]): Array<{ ts: string; count: number; errors: number }> {
  if (domains.length === 0) return [];
  return domains[0].timeSeries.map((pt, i) => ({
    ts: pt.ts,
    count: domains.reduce((s, d) => s + (d.timeSeries[i]?.count ?? 0), 0),
    errors: domains.reduce((s, d) => s + (d.timeSeries[i]?.errors ?? 0), 0),
  }));
}

function weightedAvgRt(domains: NginxDomainStat[]): number | null {
  const withRt = domains.filter((d) => d.avgRtMs != null);
  const totalReq = withRt.reduce((s, d) => s + d.requests, 0);
  if (totalReq === 0) return null;
  return Math.round(withRt.reduce((s, d) => s + (d.avgRtMs ?? 0) * d.requests, 0) / totalReq);
}


interface TooltipPayloadItem { name: string; value: number; color: string }
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={CHART_TOOLTIP_STYLE}>
      {label && <div style={{ color: "#7d8590", marginBottom: 4 }}>{label}</div>}
      {payload.map((entry) => (
        <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <Squircle size={10} fill={entry.color} color="none" strokeWidth={0} style={{ flexShrink: 0 }} />
          <span style={{ color: "#7d8590" }}>{entry.name}:</span>
          <span>{entry.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload?.length) return null;
  return (
    <div style={{ display: "flex", gap: 16, justifyContent: "center", fontSize: 12, color: "#7d8590", marginTop: 8 }}>
      {payload.map((entry) => (
        <span key={entry.value} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Squircle size={10} fill={entry.color} color="none" strokeWidth={0} style={{ flexShrink: 0 }} />
          {entry.value}
        </span>
      ))}
    </div>
  );
}

function StatCard({ label, value, sub, danger, warn }: { label: string; value: React.ReactNode; sub?: React.ReactNode; danger?: boolean; warn?: boolean }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>{label}</div>
      <div className={cn(styles.statValue, danger && styles.statDanger, warn && styles.statWarn)}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

type TabId = "overview" | "logs" | "anomalies";

export default function Traffic() {
  const navigate = useNavigate();
  const { projects, system } = useSystem();

  const [tab, setTab] = useState<TabId>("overview");
  const [period, setPeriod] = useState("24h");
  const [projectFilter, setProjectFilter] = useLocalStorageState<string[]>("traffic-project-filter", []);
  const [ignoreHealthChecks, setIgnoreHealthChecks] = useState(false);
  const [maskIps, setMaskIps] = useLocalStorageState("traffic-mask-ips", false);
  const [rules, setRules] = useLocalStorageState<Record<RuleId, boolean>>("traffic-rules", DEFAULT_RULES);
  const [columns, setColumns] = useLocalStorageState<Record<ColumnId, boolean>>("traffic-columns", DEFAULT_COLUMNS);

  const [nginx, setNginx] = useState<NginxMetrics | null>(null);
  const [logData, setLogData] = useState<NginxLogEntriesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedHost, setExpandedHost] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<NginxLogEntry | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusClassFilter, setStatusClassFilter] = useState("all");
  const [slowOnly, setSlowOnly] = useState(false);
  const [unusualOnly, setUnusualOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const host = projectFilter.length === 1 ? projectFilter[0] : undefined;
      const [agg, entries] = await Promise.all([
        api.getNginxMetrics({ period, excludeHealthChecks: ignoreHealthChecks || undefined }),
        api.getNginxLogEntries({ period, excludeHealthChecks: ignoreHealthChecks || undefined, host, limit: LOG_LIMIT }),
      ]);
      setNginx(agg);
      setLogData(entries);
    } catch {
      setError("Failed to load traffic data.");
    } finally {
      setLoading(false);
    }
  }, [period, ignoreHealthChecks, projectFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setExpandedHost(null); }, [projectFilter]);

  const projectsWithDomain = useMemo(() => (projects ?? []).filter((p) => (p.domains?.length ?? 0) > 0), [projects]);
  const projectDomainRows = useMemo(
    () => projectsWithDomain.flatMap((p) => p.domains!.map((d) => ({ project: p, domain: d.domain }))),
    [projectsWithDomain],
  );
  const projectOptions = useMemo(
    () => projectDomainRows.map((row) => ({
      value: row.domain,
      label: (row.project.domains?.length ?? 0) > 1 ? `${row.project.name} (${row.domain})` : row.project.name,
    })),
    [projectDomainRows],
  );

  const activeHosts = projectFilter.length > 0 ? new Set(projectFilter) : null;

  const rawEntries = logData?.entries ?? [];
  const entries = useMemo(
    () => (activeHosts && projectFilter.length > 1 ? rawEntries.filter((e) => e.host != null && activeHosts.has(e.host)) : rawEntries),
    [rawEntries, projectFilter], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const flagged = useMemo(() => entries.map((entry) => ({ entry, flags: flagsFor(entry, rules) })).filter((x) => x.flags.length > 0), [entries, rules]);

  const scopedDomains = activeHosts ? (nginx?.domains ?? []).filter((d) => activeHosts.has(d.host)) : [];
  const isScoped = scopedDomains.length > 0;
  const scopedProjects = activeHosts ? projectsWithDomain.filter((p) => p.domains!.some((d) => activeHosts.has(d.domain))) : [];

  const statusCodes = isScoped ? mergeStatusCodes(scopedDomains) : (nginx?.statusCodes ?? {});
  const split = statusSplit(statusCodes);
  const totalRequests = isScoped ? scopedDomains.reduce((s, d) => s + d.requests, 0) : (nginx?.totalRequests ?? 0);
  const bytesTotal = isScoped ? scopedDomains.reduce((s, d) => s + d.bytes, 0) : (nginx?.bytesTotal ?? 0);
  const timeSeries = isScoped ? mergeTimeSeries(scopedDomains) : (nginx?.timeSeries ?? []);
  const granularity = nginx?.granularity ?? "hour";
  const peakCount = timeSeries.reduce((max, pt) => Math.max(max, pt.count), 0);
  const avgRtMsScoped = isScoped ? weightedAvgRt(scopedDomains) : null;

  const downProjects = projectsWithDomain.filter((p) => p.lastStatus === "down");
  const healthBannerMessage = (() => {
    if (!isScoped) {
      return downProjects.length > 0
        ? `${downProjects.length} project${downProjects.length > 1 ? "s" : ""} reporting a failed health check.`
        : "";
    }
    const downSelected = scopedProjects.filter((p) => p.lastStatus === "down");
    if (downSelected.length > 0) {
      return downSelected.length === 1
        ? `${downSelected[0].name} health check is DOWN as of ${downSelected[0].lastCheckedAt ? formatClock(downSelected[0].lastCheckedAt) : "unknown"}.`
        : `${downSelected.length} of the selected projects are reporting a failed health check.`;
    }
    const othersDown = downProjects.length - downSelected.length;
    return othersDown > 0 ? `${othersDown} other project${othersDown > 1 ? "s" : ""} reporting a failed health check.` : "";
  })();

  function jumpTo(nextTab: TabId, host?: string) {
    if (host) setProjectFilter([host]);
    setTab(nextTab);
  }

  function openEntry(entry: NginxLogEntry) {
    setSelectedEntry(entry);
  }

  function filterThisIp(ip: string) {
    setSearch(ip);
    setTab("logs");
    setSelectedEntry(null);
  }

  async function blockAtEdge(ip: string) {
    try {
      await navigator.clipboard.writeText(ip);
      notify.success(`${ip} copied — add a DROP rule in VPS → Firewall.`);
    } catch {
      notify.success(`Add a DROP rule for ${ip} in VPS → Firewall.`);
    }
    setSelectedEntry(null);
    navigate("/infrastructure");
  }

  const methodOptions = useMemo(() => {
    const methods = Array.from(new Set(entries.map((e) => e.method))).sort();
    return [{ value: "all", label: "Any method" }, ...methods.map((m) => ({ value: m, label: m }))];
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (q && !`${e.ip} ${e.method} ${e.path} ${e.host ?? ""} ${e.ua ?? ""}`.toLowerCase().includes(q)) return false;
      if (methodFilter !== "all" && e.method !== methodFilter) return false;
      if (statusClassFilter !== "all" && `${Math.floor(e.status / 100)}xx` !== statusClassFilter) return false;
      if (slowOnly && (e.requestTimeMs == null || e.requestTimeMs < 1000)) return false;
      if (unusualOnly && flagsFor(e, rules).length === 0) return false;
      return true;
    });
  }, [entries, search, methodFilter, statusClassFilter, slowOnly, unusualOnly, rules]);

  const anomalyGroups = useMemo(() => {
    const map = new Map<RuleId, NginxLogEntry[]>();
    for (const { entry, flags } of flagged) {
      for (const f of flags) {
        const list = map.get(f.ruleId) ?? [];
        if (!list.includes(entry)) list.push(entry);
        map.set(f.ruleId, list);
      }
    }
    return RULES.filter((r) => rules[r.id] && map.has(r.id))
      .map((r) => ({ rule: r, items: map.get(r.id) ?? [] }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [flagged, rules]);

  const highSeverityCount = flagged.filter((x) => x.flags.some((f) => f.sev === "high")).length;
  const distinctFlaggedIps = new Set(flagged.map((x) => x.entry.ip)).size;
  const errorResponseCount = entries.filter((e) => e.status >= 500).length;

  return (
    <main className="main">
      <div className="page-header">
        <h1 className="page-title">
          <Radar size={18} style={{ display: "inline", marginRight: 8, verticalAlign: "text-bottom" }} />
          Traffic
        </h1>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.selectorGroup}>
          <MultiSelect
            options={projectOptions}
            selected={projectFilter}
            onChange={setProjectFilter}
            allLabel="All projects"
            triggerClassName={styles.projectSelect}
          />
          <AppSelect value={period} onValueChange={setPeriod} options={PERIOD_OPTIONS} triggerClassName={styles.periodSelect} size="sm" />
        </div>
        <label className={styles.ipToggle}>
          <Switch size="sm" checked={ignoreHealthChecks} onCheckedChange={setIgnoreHealthChecks} />
          <span>Ignore health checks</span>
        </label>
        <button className="btn btn-ghost btn-sm" onClick={() => setMaskIps((v) => !v)} title="Mask client IPs">
          {maskIps ? <EyeOff size={13} /> : <Eye size={13} />}
          {maskIps ? "Unmask IPs" : "Mask IPs"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setConfigOpen(true)} title="Settings">
          <Settings size={13} />
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="card" style={{ padding: "6px 12px", marginBottom: 16 }}>
        <div className="row" style={{ display: "flex", gap: 4 }}>
          {(["overview", "logs", "anomalies"] as TabId[]).map((t) => (
            <button
              key={t}
              type="button"
              className={cn("btn btn-ghost btn-sm", tab === t && "btn-primary")}
              onClick={() => setTab(t)}
            >
              {t === "overview" ? "Overview" : t === "logs" ? "Log inspector" : "Anomalies"}
              {t === "anomalies" && flagged.length > 0 && (
                <Badge variant="destructive" className={styles.tabBadge}>{flagged.length}</Badge>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" && (
        <>
          {healthBannerMessage && (
            <div className={styles.healthBanner}>
              <AlertCircle size={13} />
              {healthBannerMessage}
            </div>
          )}

          <div className={styles.statGrid}>
            <StatCard label="Requests" value={totalRequests.toLocaleString()} sub={peakCount > 0 ? `peak ${peakCount.toLocaleString()} / ${granularity === "hour" ? "hr" : "day"}` : undefined} />
            <StatCard label="5xx rate" value={`${split.rate5xx.toFixed(1)}%`} sub="server errors" danger={split.rate5xx > 1} />
            <StatCard label="4xx rate" value={`${split.rate4xx.toFixed(1)}%`} sub="clients + probes" warn={split.rate4xx > 10} />
            <StatCard
              label={isScoped ? "Avg latency" : "P95 latency"}
              value={formatMs(isScoped ? avgRtMsScoped : nginx?.p95ResponseMs)}
            />
            <StatCard label="Egress" value={formatBytes(bytesTotal)} sub={`${period} window`} />
            <StatCard label="Flagged" value={flagged.length} sub="in recent sample" danger={flagged.length > 0} />
          </div>

          <div className={styles.nginxGrid}>
            <div className="card" style={{ padding: 12 }}>
              <div className="card-title">Requests over time</div>
              {loading ? (
                <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
              ) : timeSeries.length > 0 ? (
                <div className={styles.chartWrap}>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={timeSeries} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
                      <XAxis dataKey="ts" tick={CHART_TICK} interval={granularity === "day" ? 0 : 3} tickFormatter={granularity === "day" ? formatDate : formatHour} />
                      <YAxis tick={CHART_TICK} allowDecimals={false} />
                      <Tooltip cursor={{ stroke: CHART_GRID_COLOR }} content={<ChartTooltip />} />
                      <Line type="monotone" dataKey="count" name="Requests" stroke="#6366f1" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="errors" name="Errors" stroke="#f85149" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                      <Legend content={<ChartLegend />} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className={styles.noData}>No traffic data for this window.</div>
              )}
            </div>
            <div className="card" style={{ padding: 12 }}>
              <div className="card-title">Status classes</div>
              {loading ? (
                <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
              ) : groupStatusCodes(statusCodes).length > 0 ? (
                <div className={styles.chartWrap}>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={groupStatusCodes(statusCodes)} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {groupStatusCodes(statusCodes).map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                      <Legend content={<ChartLegend />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className={styles.noData}>No status data.</div>
              )}
            </div>
          </div>

          {nginx?.domains && nginx.domains.length > 0 && (() => {
            const visibleDomains = activeHosts ? nginx.domains.filter((d) => activeHosts.has(d.host)) : nginx.domains;
            return (
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="card-title" style={{ padding: "10px 12px", margin: 0, borderBottom: "1px solid var(--border)", justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Globe size={13} />Projects</span>
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>click a row to drill down</span>
              </div>
              <div className={cn("table-wrap", styles.metricsTable)}>
                <table>
                  <thead>
                    <tr>
                      <th className={styles.colDomain}>Project</th>
                      <th className={styles.colCount}>Requests</th>
                      {columns.s5 && <th className={cn(styles.colCount, styles.colSecondary)}>5xx</th>}
                      {columns.err && <th className={cn(styles.colCount, styles.colSecondary)}>4xx</th>}
                      {columns.rt && <th className={cn(styles.colCount, styles.colSecondary)}>Avg RT</th>}
                      {columns.bw && <th className={cn(styles.colCount, styles.colSecondary)}>Egress</th>}
                      {columns.flags && <th className={styles.colCount}>Flags</th>}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDomains.map((d) => {
                      const open = expandedHost === d.host;
                      const dSplit = statusSplit(d.statusCodes);
                      const hostFlags = flagged.filter((x) => x.entry.host === d.host).length;
                      const proj = projectDomainRows.find((row) => row.domain === d.host)?.project;
                      const appDomain = system?.nginx?.layer?.app?.domain;
                      const isStackPort = !!appDomain && d.host.toLowerCase() === appDomain.toLowerCase();
                      const maxPath = d.topPaths[0]?.count ?? 1;
                      const topIps = (() => {
                        const tally = new Map<string, { count: number; flagged: boolean }>();
                        for (const { entry, flags } of entries.filter((e) => e.host === d.host).map((e) => ({ entry: e, flags: flagsFor(e, rules) }))) {
                          const cur = tally.get(entry.ip) ?? { count: 0, flagged: false };
                          cur.count++;
                          if (flags.length > 0) cur.flagged = true;
                          tally.set(entry.ip, cur);
                        }
                        return Array.from(tally.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
                      })();
                      return (
                        <React.Fragment key={d.host}>
                          <tr className={cn(styles.domainRow, open && styles.domainRowActive)} onClick={() => setExpandedHost(open ? null : d.host)}>
                            <td className="mono">
                              <ChevronRight size={13} className={cn(styles.domainChevron, open && styles.domainChevronOpen)} />
                              {isStackPort ? (
                                // StackPort's own domain isn't a row in the projects table (it's nginx
                                // app config, not a project) — if this page loaded at all, the control
                                // plane serving it is definitionally reachable, so this is always "up".
                                <StatusChip ok labels={["active", "inactive"]} />
                              ) : (
                                <span className={cn(styles.statusDot, proj?.lastStatus === "up" ? styles.statusUp : proj?.lastStatus === "down" ? styles.statusDown : undefined)} />
                              )}
                              <span className={styles.projectCell}>
                                <span className={styles.projectName}>{isStackPort ? "StackPort" : proj?.name ?? d.host}</span>
                                {(proj || isStackPort) && <span className={styles.projectHost}>{d.host}{proj?.internalPort ? `:${proj.internalPort}` : ""}</span>}
                              </span>
                            </td>
                            <td className={cn("mono", styles.colCount)}>{d.requests.toLocaleString()}</td>
                            {columns.s5 && (
                              <td className={cn("mono", styles.colCount, styles.colSecondary)}>
                                <span className={cn(styles.rateBadge, dSplit.rate5xx > 1 ? styles.rateErr : styles.rateOk)}>{Math.round(dSplit.rate5xx / 100 * d.requests)}</span>
                              </td>
                            )}
                            {columns.err && <td className={cn("mono", styles.colCount, styles.colSecondary)} style={{ color: "var(--dim)" }}>{dSplit.rate4xx.toFixed(1)}%</td>}
                            {columns.rt && <td className={cn("mono", styles.colCount, styles.colSecondary)} style={{ color: "var(--dim)" }}>{formatMs(d.avgRtMs)}</td>}
                            {columns.bw && <td className={cn("mono", styles.colCount, styles.colSecondary)} style={{ color: "var(--dim)" }}>{formatBytes(d.bytes)}</td>}
                            {columns.flags && (
                              <td className={styles.colCount}>
                                {hostFlags > 0 ? <Badge variant="destructive">{hostFlags}</Badge> : <span className="mono" style={{ color: "var(--dim)" }}>0</span>}
                              </td>
                            )}
                            <td />
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={8} style={{ padding: 0 }}>
                                <div className={styles.domainDetail}>
                                  <div>
                                    <div className={styles.detailColTitle}>Top endpoints</div>
                                    {d.topPaths.slice(0, 5).map((p) => (
                                      <div key={p.path} className={styles.pathItem}>
                                        <div className={cn("mono", styles.pathRow)}>
                                          <span className={styles.trunc}>{p.path}</span>
                                          <span>{p.count}</span>
                                        </div>
                                        <div className={styles.pathBar}>
                                          <div style={{ width: `${(p.count / maxPath) * 100}%` }} />
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  <div>
                                    <div className={styles.detailColTitle}>Top source IPs (recent sample)</div>
                                    {topIps.length === 0 ? (
                                      <div className={styles.noData}>No sampled requests.</div>
                                    ) : topIps.map(([ip, info]) => (
                                      <div key={ip} className={cn("mono", styles.ipRow, info.flagged && styles.ipRowFlagged)}>
                                        <span>{maskIp(ip, maskIps)}</span>
                                        <span>{info.count}{info.flagged ? " · flagged" : ""}</span>
                                      </div>
                                    ))}
                                  </div>
                                  <div>
                                    <div className={styles.detailColTitle}>Actions</div>
                                    <button className="btn btn-ghost btn-sm btn-full" style={{ marginBottom: 6, justifyContent: "flex-start" }} onClick={(e) => { e.stopPropagation(); jumpTo("logs", d.host); }}>
                                      <Search size={12} />Open logs
                                    </button>
                                    <button className="btn btn-ghost btn-sm btn-full" style={{ justifyContent: "flex-start" }} onClick={(e) => { e.stopPropagation(); jumpTo("anomalies", d.host); }}>
                                      <ShieldAlert size={12} />Inspect anomalies
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}
        </>
      )}

      {tab === "logs" && (
        <>
          <div className={styles.filterBar}>
            <div className={styles.searchWrap}>
              <Search size={13} />
              <input placeholder="Search IP, path, host, user-agent…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <AppSelect value={methodFilter} onValueChange={setMethodFilter} options={methodOptions} triggerClassName={styles.filterSelect} size="sm" />
            <AppSelect
              value={statusClassFilter}
              onValueChange={setStatusClassFilter}
              options={[{ value: "all", label: "Any status" }, { value: "2xx", label: "2xx" }, { value: "3xx", label: "3xx" }, { value: "4xx", label: "4xx" }, { value: "5xx", label: "5xx" }]}
              triggerClassName={styles.filterSelect}
              size="sm"
            />
            <button className={cn("btn btn-ghost btn-sm", slowOnly && "btn-primary")} onClick={() => setSlowOnly((v) => !v)}>
              <Clock size={12} />Slow &gt;1s
            </button>
            <button className={cn("btn btn-ghost btn-sm", unusualOnly && "btn-primary")} onClick={() => setUnusualOnly((v) => !v)}>
              <Filter size={12} />Unusual only
            </button>
          </div>

          <div className={styles.logMeta}>
            {filteredEntries.length} of {entries.length} entries
            {logData?.truncated ? ` · showing the most recent ${LOG_LIMIT}` : ""}
            {projectFilter.length > 0 ? ` · ${multiSelectSummary(projectFilter, projectOptions, "All projects")}` : ""}
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            {loading ? (
              <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
            ) : !logData?.available ? (
              <div className={styles.noData}>{logData?.error ?? "Nginx access log not found."}</div>
            ) : filteredEntries.length === 0 ? (
              <div className={styles.noData}>No requests match these filters.</div>
            ) : (
              filteredEntries.map((e) => {
                const f = flagsFor(e, rules);
                const hi = f.some((x) => x.sev === "high");
                return (
                  <div key={`${e.time}-${e.ip}-${e.path}`} className={cn(styles.logRow, hi && styles.logRowFlagged)} onClick={() => openEntry(e)}>
                    <span style={{ color: "var(--dim)" }}>{formatClock(e.time)}</span>
                    <span className={cn("mono", styles.trunc)} style={{ color: "var(--dim)" }}>{maskIp(e.ip, maskIps)}</span>
                    <span style={{ color: e.method === "GET" ? "var(--brand)" : e.method === "POST" ? "var(--success)" : "var(--danger)" }}>{e.method}</span>
                    <span className={styles.trunc}>{e.path}</span>
                    <span style={{ color: statusColor(e.status) }}>{e.status}</span>
                    <span style={{ textAlign: "right", display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {f.slice(0, 2).map((x) => <Badge key={x.label} variant={severityVariant(x.sev)}>{x.label}</Badge>)}
                      {f.length > 2 && <span style={{ color: "var(--dim)" }}>+{f.length - 2}</span>}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {tab === "anomalies" && (
        <>
          <div className={styles.statGrid}>
            <StatCard label="High severity" value={highSeverityCount} danger={highSeverityCount > 0} />
            <StatCard label="Flagged IPs" value={distinctFlaggedIps} />
            <StatCard label="Error responses (5xx)" value={errorResponseCount} danger={errorResponseCount > 0} />
            <StatCard label="Total flagged" value={flagged.length} sub="in recent sample" />
          </div>

          {loading ? (
            <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
          ) : anomalyGroups.length === 0 ? (
            <div className="card" style={{ padding: 28, textAlign: "center" }}>
              <div className={styles.noData}>No anomalies in this window. Enable more rules in settings to widen detection.</div>
            </div>
          ) : (
            <div className={styles.anomalyGroups}>
              {anomalyGroups.map(({ rule, items }) => (
                <ExpandableCard
                  key={rule.id}
                  defaultOpen
                  title={
                    <span className={styles.groupHeader}>
                      <span className={cn(styles.severityDot, rule.sev === "high" ? styles.sevHigh : rule.sev === "med" ? styles.sevMed : styles.sevLow)} />
                      {rule.label}
                      <Badge variant={severityVariant(rule.sev)}>{rule.sev}</Badge>
                    </span>
                  }
                  summary={<span className={styles.groupCount}>{items.length} req</span>}
                >
                  {items.slice(0, 8).map((e) => (
                    <div key={`${e.time}-${e.ip}-${e.path}`} className={cn("mono", styles.anomalyItem)} onClick={() => openEntry(e)}>
                      <span style={{ color: "var(--dim)" }}>{formatClock(e.time)}</span>
                      <span style={{ color: "var(--dim)" }}>{maskIp(e.ip, maskIps)}</span>
                      <span className={styles.trunc}>{e.method} {e.path}</span>
                      <span style={{ color: statusColor(e.status) }}>{e.status}</span>
                    </div>
                  ))}
                </ExpandableCard>
              ))}
            </div>
          )}
        </>
      )}

      {selectedEntry && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedEntry(null); }}>
          <div className="modal-panel">
            <div className={styles.modalHeader}>
              <span>Request detail</span>
              <button className={styles.modalClose} onClick={() => setSelectedEntry(null)} aria-label="Close"><X size={16} /></button>
            </div>
            {(() => {
              const f = flagsFor(selectedEntry, rules);
              const raw = `${selectedEntry.ip} - - [${new Date(selectedEntry.time).toISOString()}] "${selectedEntry.method} ${selectedEntry.path} HTTP/1.1" ${selectedEntry.status} ${selectedEntry.bytes} "-" "${selectedEntry.ua ?? "-"}" "${selectedEntry.host ?? "-"}" ${selectedEntry.requestTimeMs != null ? (selectedEntry.requestTimeMs / 1000).toFixed(3) : "-"}`;
              const rows: Array<[string, React.ReactNode]> = [
                ["Host (project)", selectedEntry.host ?? "—"],
                ["Client IP", maskIp(selectedEntry.ip, maskIps)],
                ["Method", selectedEntry.method],
                ["Path", selectedEntry.path],
                ["Status", <span style={{ color: statusColor(selectedEntry.status) }}>{selectedEntry.status}</span>],
                ["Request time", formatMs(selectedEntry.requestTimeMs)],
                ["Bytes sent", selectedEntry.bytes.toLocaleString()],
                ["User-agent", selectedEntry.ua || "—"],
              ];
              return (
                <>
                  {f.length > 0 && (
                    <div className={styles.flagBanner}>
                      <div className={styles.flagBannerTitle}>Flagged by {f.length} rule{f.length > 1 ? "s" : ""}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {f.map((x) => <Badge key={x.label} variant={severityVariant(x.sev)}>{x.label}</Badge>)}
                      </div>
                    </div>
                  )}
                  <div className={styles.kvList}>
                    {rows.map(([k, v]) => (
                      <div key={k} className={styles.kvRow}>
                        <span className={styles.kvKey}>{k}</span>
                        <span className="mono">{v}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--dim)", margin: "12px 0 4px" }}>Raw log line</div>
                  <div className="output-block">{raw}</div>
                  <div className={styles.detailActions}>
                    <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => filterThisIp(selectedEntry.ip)}>
                      <Search size={13} />Filter this IP
                    </button>
                    <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => void blockAtEdge(selectedEntry.ip)}>
                      <Copy size={13} />Block IP at edge
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {configOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfigOpen(false); }}>
          <div className="modal-panel">
            <div className={styles.modalHeader}>
              <span>Traffic settings</span>
              <button className={styles.modalClose} onClick={() => setConfigOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>

            <div className={styles.configSection}>
              <div className={styles.configSectionTitle}>Display</div>
              <div className={styles.switchRow}>
                <span>Mask client IPs</span>
                <Switch checked={maskIps} onCheckedChange={setMaskIps} />
              </div>
            </div>

            <div className={styles.configSection}>
              <div className={styles.configSectionTitle}>Project table columns</div>
              <div className={styles.columnGrid}>
                {COLUMNS.map((c) => (
                  <label key={c.id} className={styles.switchRow} style={{ cursor: "pointer" }}>
                    <span>{c.label}</span>
                    <Switch checked={columns[c.id]} onCheckedChange={(v) => setColumns((cur) => ({ ...cur, [c.id]: v }))} />
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.configSection}>
              <div className={styles.configSectionTitle}>Anomaly detection — {flagged.length} matched</div>
              {RULES.map((r) => (
                <div key={r.id} className={styles.ruleRow}>
                  <div className={styles.ruleRowHead}>
                    <span className={cn(styles.severityDot, r.sev === "high" ? styles.sevHigh : r.sev === "med" ? styles.sevMed : styles.sevLow)} />
                    <span>{r.label}</span>
                    <Switch style={{ marginLeft: "auto" }} checked={rules[r.id]} onCheckedChange={(v) => setRules((cur) => ({ ...cur, [r.id]: v }))} />
                  </div>
                  <div className={styles.ruleDesc}>{r.desc}</div>
                </div>
              ))}
            </div>

            <div className={styles.configSection}>
              <div className={styles.configSectionTitle}>Nginx log format</div>
              <div className="output-block">{RECOMMENDED_LOG_FORMAT}</div>
              <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 8, lineHeight: 1.5 }}>
                This is the format Stackport already writes for every routed domain (see System → Nginx) — it includes <span className="mono">$host</span> and <span className="mono">$request_time</span>, which is everything this page's rules and metrics need.
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
