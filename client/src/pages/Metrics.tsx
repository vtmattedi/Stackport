import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart2, RefreshCw, Loader, Activity, Cpu, List,
  ChevronRight, ChevronUp, ChevronDown, Info, XCircle,
} from "lucide-react";
import { Squircle } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AreaChart, Area, ResponsiveContainer,
} from "recharts";
import { Tooltip as UiTooltip, TooltipContent as UiTooltipContent, TooltipProvider as UiTooltipProvider, TooltipTrigger as UiTooltipTrigger } from "../components/ui/tooltip";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "../components/ui/chart";
import { MultiSelect } from "../components/MultiSelect";
import { AppSelect } from "../components/AppSelect";
import { api } from "../api/client";
import type { MetricsData, ProjectResourceData, ProjectResourceSummary, ProjectResourceSummaryItem, ProjectResourcesTimeseries, ResourceMetric } from "../api/types";
import { formatTimeAgo } from "../lib/format";
import { formatMb, CHART_TICK, CHART_GRID_COLOR, CHART_TOOLTIP_STYLE, formatChartTick } from "../lib/charts";
import { cn } from "../lib/utils";
import { ProjectResourceCharts } from "../components/ProjectResourceCharts";
import styles from "./Metrics.module.scss";

const CURSOR_FILL = "rgba(255,255,255,0.05)";

const PROJECT_COLORS = ["#6366f1", "#3fb950", "#f0b429", "#f85149", "#22d3ee", "#c084fc", "#818cf8", "#fb923c"];

const PERIOD_OPTIONS: { value: string; label: string; days: number; hours: number }[] = [
  { value: "24h", label: "24 h", days: 1, hours: 24 },
  { value: "7d", label: "7 d", days: 7, hours: 168 },
  { value: "30d", label: "30 d", days: 30, hours: 168 },
];

const RESOURCE_METRIC_OPTIONS: { value: ResourceMetric; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "mem", label: "Memory" },
  { value: "net", label: "Network" },
  { value: "disk", label: "Disk" },
];

interface TooltipPayloadItem { name: string; value: number; color: string }
function DeployChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }) {
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

function DeployChartLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
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

function formatDate(date: React.ReactNode): string {
  const d = new Date(String(date));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function fractionColor(n: number, total: number): "green" | "yellow" | "red" | null {
  if (total === 0) return null;
  if (n === total) return "green";
  if (n === total - 1) return "yellow";
  return "red";
}

const CARD_COLOR: Record<string, string> = {
  green: styles.statCardGreen,
  yellow: styles.statCardYellow,
  red: styles.statCardRed,
};
const TEXT_COLOR: Record<string, string> = {
  green: styles.statColorGreen,
  yellow: styles.statColorYellow,
  red: styles.statColorRed,
};

function StatFraction({ n, total, label, sub, details, action }: {
  n: number; total: number; label: string; sub?: React.ReactNode; details?: React.ReactNode; action?: React.ReactNode;
}) {
  const color = fractionColor(n, total);
  const showInfo = (color === "yellow" || color === "red") && !!details;
  return (
    <div className={cn(styles.statCard, color && CARD_COLOR[color])}>
      <div className={styles.statLabelRow}>
        <span className={styles.statLabel}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {action}
          {showInfo && (
            <UiTooltip>
              <UiTooltipTrigger asChild>
                <button type="button" className={styles.statInfoBtn} aria-label={`Why ${label} needs attention`}>
                  <Info size={12} />
                </button>
              </UiTooltipTrigger>
              <UiTooltipContent side="top">{details}</UiTooltipContent>
            </UiTooltip>
          )}
        </div>
      </div>
      <div className={styles.statFraction}>
        <span className={cn(styles.statFractionN, color && TEXT_COLOR[color])}>{n}</span>
        <span className={styles.statFractionSep}>/</span>
        <span className={styles.statFractionTotal}>{total}</span>
      </div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

type SortColumn = "cpu" | "memory" | "net" | "disk";

function sortValue(p: ProjectResourceSummaryItem, column: SortColumn): number {
  switch (column) {
    case "cpu": return p.cpuPercent;
    case "memory": return p.memUsedMb;
    case "net": return p.netRxMb + p.netTxMb;
    case "disk": return p.diskSizeMb ?? -1;
  }
}

function SortableHeader({ label, className, active, dir, onClick }: {
  label: string; className?: string; active: boolean; dir: "asc" | "desc"; onClick: () => void;
}) {
  return (
    <th className={className} onClick={onClick} style={{ cursor: "pointer", userSelect: "none" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
        {label}
        {active && (dir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  );
}

export default function Metrics() {
  const [period, setPeriod] = useState("30d");
  const selectedPeriod = PERIOD_OPTIONS.find((p) => p.value === period) ?? PERIOD_OPTIONS[2];
  const resourceWindowLabel = selectedPeriod.hours >= 168 ? "7 d" : "24 h";

  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingAll, setCheckingAll] = useState(false);
  const [error, setError] = useState("");

  const [resourceSummary, setResourceSummary] = useState<ProjectResourceSummary | null>(null);
  const [resourceLoading, setResourceLoading] = useState(true);
  const [selectedResourceProject, setSelectedResourceProject] = useState<number | null>(null);
  const [resourceDetail, setResourceDetail] = useState<ProjectResourceData | null>(null);
  const [resourceDetailLoading, setResourceDetailLoading] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [chartProjectIds, setChartProjectIds] = useState<string[]>([]);
  const [resourceMetric, setResourceMetric] = useState<ResourceMetric>("cpu");
  const [timeseries, setTimeseries] = useState<ProjectResourcesTimeseries | null>(null);
  const [timeseriesLoading, setTimeseriesLoading] = useState(true);

  const loadResources = useCallback(async (hours: number) => {
    setResourceLoading(true);
    try {
      const data = await api.getProjectResourcesSummary(hours);
      setResourceSummary(data);
      setSelectedResourceProject((current) => current && data.projects.some((p) => p.projectId === current) ? current : null);
    } catch {
      setResourceSummary(null);
    } finally {
      setResourceLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getMetrics(selectedPeriod.days);
      setMetrics(data);
    } catch {
      setError("Failed to load metrics.");
    } finally {
      setLoading(false);
    }
    void loadResources(selectedPeriod.hours);
  }, [loadResources, selectedPeriod.days, selectedPeriod.hours]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (selectedResourceProject == null) {
      setResourceDetail(null);
      return;
    }
    let cancelled = false;
    setResourceDetailLoading(true);
    api.getProjectResources(selectedResourceProject, selectedPeriod.hours)
      .then((data) => { if (!cancelled) setResourceDetail(data); })
      .catch(() => { if (!cancelled) setResourceDetail(null); })
      .finally(() => { if (!cancelled) setResourceDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedResourceProject, selectedPeriod.hours]);

  useEffect(() => {
    let cancelled = false;
    setTimeseriesLoading(true);
    api.getProjectResourcesTimeseries({
      hours: selectedPeriod.hours,
      metric: resourceMetric,
      projectIds: chartProjectIds.map(Number),
    })
      .then((data) => { if (!cancelled) setTimeseries(data); })
      .catch(() => { if (!cancelled) setTimeseries(null); })
      .finally(() => { if (!cancelled) setTimeseriesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedPeriod.hours, resourceMetric, chartProjectIds]);

  const checkAll = useCallback(async () => {
    if (!metrics?.healthChecks.projects.length) return;
    setCheckingAll(true);
    await Promise.allSettled(metrics.healthChecks.projects.map((p) => api.checkProject(p.id)));
    setCheckingAll(false);
    const data = await api.getMetrics(selectedPeriod.days).catch(() => null);
    if (data) setMetrics(data);
  }, [metrics, selectedPeriod.days]);

  function handleSort(column: SortColumn) {
    if (sortColumn === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDir("desc");
    }
  }

  const sortedProjects = useMemo(() => {
    const projects = resourceSummary?.projects ?? [];
    if (!sortColumn) return projects;
    const sorted = [...projects].sort((a, b) => sortValue(a, sortColumn) - sortValue(b, sortColumn));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [resourceSummary, sortColumn, sortDir]);

  const selectedResourceProjectName = resourceSummary?.projects.find((p) => p.projectId === selectedResourceProject)?.name;

  const projectOptions = useMemo(
    () => (resourceSummary?.projects ?? []).map((p) => ({ value: String(p.projectId), label: p.name })),
    [resourceSummary],
  );

  const chartConfig: ChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    timeseries?.series.forEach((s, i) => {
      config[String(s.projectId)] = { label: s.name, color: PROJECT_COLORS[i % PROJECT_COLORS.length] };
    });
    return config;
  }, [timeseries]);

  const chartRows = useMemo(() => {
    if (!timeseries) return [];
    return timeseries.buckets.map((ts, i) => {
      const row: Record<string, number | string> = { ts };
      for (const s of timeseries.series) row[String(s.projectId)] = s.values[i] ?? 0;
      return row;
    });
  }, [timeseries]);

  const resourceTickFormatter = timeseries?.granularity === "day" ? formatDate : formatChartTick;

  const failedDeployDetails = metrics && metrics.deploys.recentFailures.length > 0 ? (
    <div>
      <div className={styles.statInfoTitle}>Recent failed deploys</div>
      <ul className={styles.statInfoList}>
        {metrics.deploys.recentFailures.map((f) => (
          <li key={f.id}>{f.projectName} — {formatTimeAgo(f.createdAt)}</li>
        ))}
      </ul>
    </div>
  ) : undefined;

  const downHealthChecks = metrics?.healthChecks.projects.filter((p) => p.status !== "up") ?? [];
  const downHealthCheckDetails = downHealthChecks.length > 0 ? (
    <div>
      <div className={styles.statInfoTitle}>Failing health checks</div>
      <ul className={styles.statInfoList}>
        {downHealthChecks.map((p) => (
          <li key={p.id}>{p.name} — last checked {formatTimeAgo(p.lastCheckedAt, "never")}</li>
        ))}
      </ul>
    </div>
  ) : undefined;

  return (
    <main className="main">
      <div className="page-header">
        <h1 className="page-title">
          <BarChart2 size={18} style={{ display: "inline", marginRight: 8, verticalAlign: "text-bottom" }} />
          Metrics
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          <AppSelect value={period} onValueChange={setPeriod} options={PERIOD_OPTIONS} triggerClassName={styles.periodSelect} size="sm" />
          <button
            className={cn("btn btn-ghost btn-sm", styles.refreshBtn)}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>{error}</div>}

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      {metrics && (
        <UiTooltipProvider>
          <div className={styles.statGrid}>
            <StatFraction
              label="Deploys"
              n={metrics.deploys.success}
              total={metrics.deploys.total}
              sub={metrics.deploys.failed > 0
                ? <span className={styles.statDanger}>{metrics.deploys.failed} failed</span>
                : <span className={styles.statSuccess}>all successful</span>
              }
              details={failedDeployDetails}
            />
            <StatFraction
              label="Health Checks"
              n={metrics.healthChecks.projects.filter((p) => p.status === "up").length}
              total={metrics.healthChecks.projects.length}
              sub={downHealthChecks.length > 0
                ? <span className={styles.statDanger}>{downHealthChecks.length} down</span>
                : <span className={styles.statSuccess}>all healthy</span>
              }
              details={downHealthCheckDetails}
              action={metrics.healthChecks.projects.length > 0 && (
                <button
                  type="button"
                  className={styles.statInfoBtn}
                  onClick={() => void checkAll()}
                  disabled={checkingAll || loading}
                  title="Recheck all health checks"
                >
                  {checkingAll ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                </button>
              )}
            />
            <StatFraction
              label="Emails"
              n={metrics.notifications.success}
              total={metrics.notifications.total}
              sub={metrics.notifications.failed > 0
                ? <span className={styles.statDanger}>{metrics.notifications.failed} failed</span>
                : <span className={styles.statSuccess}>all delivered</span>
              }
            />
          </div>
        </UiTooltipProvider>
      )}

      {/* ── Deploy Activity ──────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title"><Activity size={13} />Deploy Activity (last {selectedPeriod.label})</div>
        {loading ? (
          <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
        ) : metrics && metrics.deploys.byDay.length > 0 ? (
          <div className={styles.chartWrap}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={metrics.deploys.byDay} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDate} tick={CHART_TICK} />
                <YAxis tick={CHART_TICK} allowDecimals={false} />
                <Tooltip cursor={{ fill: CURSOR_FILL }} content={<DeployChartTooltip />} />
                <Bar dataKey="success" name="Success" stackId="a" fill="#3fb950" radius={[0, 0, 2, 2]} />
                <Bar dataKey="failed" name="Failed" stackId="a" fill="#f85149" radius={[2, 2, 0, 0]} />
                <Legend content={<DeployChartLegend />} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className={styles.noData}>No deploy data yet.</div>
        )}
      </div>

      {/* ── Resource Usage (stacked area chart) ─────────────────────────────── */}
      <div className="card">
        <div className="card-title">
          <Cpu size={13} />Resource Usage
          <span className="muted-text" style={{ fontWeight: 400, marginLeft: 4 }}>
            stacked by project, last {resourceWindowLabel}{timeseries?.granularity === "day" ? " (aggregated daily)" : ""}
          </span>
        </div>

        <div className={styles.resourceControls}>
          <MultiSelect
            options={projectOptions}
            selected={chartProjectIds}
            onChange={setChartProjectIds}
            allLabel="All projects"
          />
          <AppSelect
            value={resourceMetric}
            onValueChange={(v) => setResourceMetric(v as ResourceMetric)}
            options={RESOURCE_METRIC_OPTIONS}
            triggerClassName={styles.resourceMetricSelect}
            size="sm"
          />
        </div>

        {timeseriesLoading ? (
          <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
        ) : !timeseries || timeseries.series.length === 0 ? (
          <div className={styles.noData}>No project resource data yet.</div>
        ) : (
          <ChartContainer config={chartConfig} className={cn("aspect-auto w-full", styles.areaChart)}>
            <AreaChart data={chartRows} margin={{ left: 12, right: 12, top: 8 }}>
              <CartesianGrid vertical={false} stroke={CHART_GRID_COLOR} />
              <XAxis dataKey="ts" tickFormatter={resourceTickFormatter} tick={CHART_TICK} minTickGap={40} />
              <YAxis
                tick={CHART_TICK}
                tickFormatter={(v: number) => resourceMetric === "cpu" ? `${v}%` : formatMb(Number(v))}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" labelFormatter={resourceTickFormatter} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {timeseries.series.map((s) => (
                <Area
                  key={s.projectId}
                  dataKey={String(s.projectId)}
                  type="natural"
                  fill={`var(--color-${s.projectId})`}
                  fillOpacity={0.4}
                  stroke={`var(--color-${s.projectId})`}
                  stackId="a"
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </div>

      {/* ── Resource List ────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">
          <List size={13} />Resource List
          <span className="muted-text" style={{ fontWeight: 400, marginLeft: 4 }}>cpu / memory / network / disk, last {resourceWindowLabel}</span>
        </div>

        {resourceLoading ? (
          <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
        ) : !resourceSummary || resourceSummary.projects.length === 0 ? (
          <div className={styles.noData}>No project resource data yet.</div>
        ) : (
          <>
            <div className={cn("table-wrap", styles.metricsTable)}>
              <table>
                <thead>
                  <tr>
                    <th className={styles.colDomain}>Project</th>
                    <SortableHeader label="CPU" className={styles.colRequests} active={sortColumn === "cpu"} dir={sortDir} onClick={() => handleSort("cpu")} />
                    <SortableHeader label="Memory" className={styles.colRequests} active={sortColumn === "memory"} dir={sortDir} onClick={() => handleSort("memory")} />
                    <SortableHeader label={`Net (${resourceWindowLabel})`} className={cn(styles.colBandwidth, styles.colSecondary)} active={sortColumn === "net"} dir={sortDir} onClick={() => handleSort("net")} />
                    <SortableHeader label="Disk" className={cn(styles.colBandwidth, styles.colSecondary)} active={sortColumn === "disk"} dir={sortDir} onClick={() => handleSort("disk")} />
                  </tr>
                </thead>
                <tbody>
                  {sortedProjects.map((p) => (
                    <tr
                      key={p.projectId}
                      className={cn(styles.domainRow, selectedResourceProject === p.projectId && styles.domainRowActive)}
                      onClick={() => setSelectedResourceProject((current) => current === p.projectId ? null : p.projectId)}
                    >
                      <td className={cn("mono", styles.colDomain)}>
                        <ChevronRight
                          size={13}
                          className={cn(styles.domainChevron, selectedResourceProject === p.projectId && styles.domainChevronOpen)}
                        />
                        {p.name}
                      </td>
                      <td className="mono">{p.cpuPercent.toFixed(1)}%</td>
                      <td className="mono">{formatMb(p.memUsedMb)}</td>
                      <td className={cn("mono", styles.colSecondary)} style={{ color: "var(--dim)" }}>{formatMb(p.netRxMb + p.netTxMb)}</td>
                      <td className={cn("mono", styles.colSecondary)} style={{ color: "var(--dim)" }}>{p.diskSizeMb != null ? formatMb(p.diskSizeMb) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedResourceProject != null && (
              <div className={styles.domainDetail}>
                <div className={styles.domainDetailHeader}>
                  <span className="mono">{selectedResourceProjectName}</span>
                  <button type="button" className={styles.domainDetailClose} onClick={() => setSelectedResourceProject(null)} aria-label="Close">
                    <XCircle size={14} />
                  </button>
                </div>
                {resourceDetailLoading ? (
                  <div className={styles.emptyChart}><Loader size={18} className="spin" /></div>
                ) : (
                  <ProjectResourceCharts resources={resourceDetail} chartHeight={160} />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
