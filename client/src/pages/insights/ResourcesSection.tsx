import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Cpu, Layers, List, Server, XCircle } from "lucide-react";
import { AreaChart, Area, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { ProjectResourceSummaryItem, ResourceMetric } from "../../api/types";
import { CHART_GRID_COLOR, CHART_TICK, formatChartTick, formatMb } from "../../lib/charts";
import { cn } from "../../lib/utils";
import { AppSelect } from "../../components/AppSelect";
import { ProjectResourceCharts } from "../../components/ProjectResourceCharts";
import { useInsights, useScope } from "./InsightsContext";
import { useHardware, useProjectResources, useResourceHours, useResourceSummary, useResourceTimeseries } from "./data";
import {
  ChartState, formatDateTime, formatDay, formatPct, Notice, Panel, RESOURCE_RETENTION_HOURS, SERIES_COLORS, SeriesLegend, SeriesTooltip,
} from "./shared";
import styles from "./Insights.module.scss";

const METRIC_OPTIONS: Array<{ value: ResourceMetric; label: string }> = [
  { value: "cpu", label: "CPU" },
  { value: "mem", label: "Memory" },
  { value: "net", label: "Network" },
  { value: "disk", label: "Disk" },
];

type SortColumn = "cpu" | "memory" | "net" | "disk";

function sortValue(p: ProjectResourceSummaryItem, column: SortColumn): number {
  switch (column) {
    case "cpu": return p.cpuPercent;
    case "memory": return p.memUsedMb;
    case "net": return p.netRxMb + p.netTxMb;
    case "disk": return p.diskSizeMb ?? -1;
  }
}

function SortHeader({ label, column, sort, onSort, className }: {
  label: string; column: SortColumn; sort: { column: SortColumn; dir: "asc" | "desc" } | null; onSort: (c: SortColumn) => void; className?: string;
}) {
  const active = sort?.column === column;
  return (
    <th className={cn(styles.sortable, className)} onClick={() => onSort(column)} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
      {label}
      {active && (sort!.dir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </th>
  );
}

export default function ResourcesSection() {
  const { hours } = useInsights();
  const resourceHours = useResourceHours();
  const windowLabel = resourceHours >= 168 ? "7 d" : `${resourceHours} h`;
  const { isScoped, projectIds } = useScope();
  const onlyStackPort = isScoped && projectIds.length === 0;

  const hardware = useHardware();
  const summary = useResourceSummary();
  const [metric, setMetric] = useState<ResourceMetric>("cpu");
  const timeseries = useResourceTimeseries(metric);
  const [selected, setSelected] = useState<number | null>(null);
  const detail = useProjectResources(selected);
  const [sort, setSort] = useState<{ column: SortColumn; dir: "asc" | "desc" } | null>({ column: "cpu", dir: "desc" });

  const hostHistory = hardware.data?.history ?? [];
  const hostTick = resourceHours > 24 ? formatDay : formatChartTick;

  const rows = useMemo(() => {
    let list = summary.data?.projects ?? [];
    if (isScoped) list = list.filter((p) => projectIds.includes(p.projectId));
    if (!sort) return list;
    const sorted = [...list].sort((a, b) => sortValue(a, sort.column) - sortValue(b, sort.column));
    return sort.dir === "desc" ? sorted.reverse() : sorted;
  }, [summary.data, isScoped, projectIds, sort]);

  const series = onlyStackPort ? [] : timeseries.data?.series ?? [];
  const chartRows = useMemo(() => {
    const ts = timeseries.data;
    if (!ts) return [];
    return ts.buckets.map((bucket, i) => {
      const row: Record<string, number | string> = { ts: bucket };
      for (const s of ts.series) row[`p${s.projectId}`] = s.values[i] ?? 0;
      return row;
    });
  }, [timeseries.data]);
  const seriesTick = timeseries.data?.granularity === "day" ? formatDay : formatChartTick;
  const formatValue = (v: number) => (metric === "cpu" ? formatPct(v) : formatMb(v));

  function onSort(column: SortColumn) {
    setSort((cur) => (cur?.column === column ? { column, dir: cur.dir === "asc" ? "desc" : "asc" } : { column, dir: "desc" }));
  }

  return (
    <>
      {hours > RESOURCE_RETENTION_HOURS && (
        <Notice>Container and host samples are kept for 7 days, so this section shows the last 7 days.</Notice>
      )}

      <Panel
        title="Server"
        icon={Server}
        meta={`${hardware.data?.hostname ?? ""}${hardware.data ? ` · ${hardware.data.cpuCount} vCPU · ` : ""}last ${windowLabel}`}
      >
        <ChartState loading={hardware.loading} empty={hostHistory.length === 0} emptyText="No host samples yet.">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={hostHistory} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
              <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={hostTick} minTickGap={40} />
              <YAxis tick={CHART_TICK} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip cursor={{ stroke: CHART_GRID_COLOR }} content={<SeriesTooltip labelFormatter={formatDateTime} valueFormatter={(v) => formatPct(v)} />} />
              <Line type="monotone" dataKey="cpuAvg" name="CPU" stroke={SERIES_COLORS[0]} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="memAvg" name="Memory" stroke={SERIES_COLORS[1]} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="cpuMax" name="CPU peak" stroke={SERIES_COLORS[0]} strokeWidth={1} strokeDasharray="3 3" dot={false} />
              <Legend content={<SeriesLegend />} />
            </LineChart>
          </ResponsiveContainer>
        </ChartState>
      </Panel>

      <Panel
        title="Usage by project"
        icon={Layers}
        meta={`stacked, last ${windowLabel}${timeseries.data?.granularity === "day" ? " · daily" : ""}`}
        actions={<AppSelect value={metric} onValueChange={(v) => setMetric(v as ResourceMetric)} options={METRIC_OPTIONS} triggerClassName={styles.metricSelect} size="sm" />}
      >
        <ChartState loading={timeseries.loading} empty={series.length === 0} emptyText="No container samples for these projects yet." height={260}>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartRows} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
              <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={seriesTick} minTickGap={40} />
              <YAxis tick={CHART_TICK} tickFormatter={(v: number) => formatValue(Number(v))} width={56} />
              <Tooltip cursor={{ stroke: CHART_GRID_COLOR }} content={<SeriesTooltip labelFormatter={seriesTick} valueFormatter={formatValue} />} />
              {series.map((s, i) => (
                <Area
                  key={s.projectId}
                  dataKey={`p${s.projectId}`}
                  name={s.name}
                  type="monotone"
                  stackId="usage"
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fillOpacity={0.3}
                />
              ))}
              <Legend content={<SeriesLegend />} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartState>
      </Panel>

      <Panel title="Projects" icon={List} meta={`averages over the last ${windowLabel} · click a row for detail`} flush>
        {summary.loading ? (
          <ChartState loading empty={false} emptyText="" height={120}>{null}</ChartState>
        ) : rows.length === 0 ? (
          <div className={styles.emptyText}>No container samples for these projects yet.</div>
        ) : (
          <div className="table-wrap">
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Project</th>
                  <SortHeader label="CPU" column="cpu" sort={sort} onSort={onSort} className={styles.num} />
                  <SortHeader label="Memory" column="memory" sort={sort} onSort={onSort} className={styles.num} />
                  <SortHeader label="Network" column="net" sort={sort} onSort={onSort} className={cn(styles.num, styles.hideNarrow)} />
                  <SortHeader label="Disk" column="disk" sort={sort} onSort={onSort} className={cn(styles.num, styles.hideNarrow)} />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const open = selected === p.projectId;
                  return (
                    <tr key={p.projectId} className={cn(styles.clickRow, open && styles.clickRowActive)} onClick={() => setSelected(open ? null : p.projectId)}>
                      <td>
                        <ChevronRight size={13} className={cn(styles.chevron, open && styles.chevronOpen)} />
                        {p.name}
                      </td>
                      <td className={cn("mono", styles.num)}>
                        <span className={styles.meter}><span style={{ width: `${Math.min(100, p.cpuPercent)}%` }} /></span>
                        {formatPct(p.cpuPercent)}
                      </td>
                      <td className={cn("mono", styles.num)}>
                        {formatMb(p.memUsedMb)}
                        {p.memPercent > 0 && <span className={styles.dim}> · {formatPct(p.memPercent, 0)}</span>}
                      </td>
                      <td className={cn("mono", styles.num, styles.dim, styles.hideNarrow)}>{formatMb(p.netRxMb + p.netTxMb)}</td>
                      <td className={cn("mono", styles.num, styles.dim, styles.hideNarrow)}>{p.diskSizeMb != null ? formatMb(p.diskSizeMb) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {selected != null && (
          <div className={styles.drawer}>
            <div className={styles.drawerHead}>
              <span><Cpu size={13} /> {rows.find((p) => p.projectId === selected)?.name}</span>
              <button type="button" className={styles.iconBtn} onClick={() => setSelected(null)} aria-label="Close detail">
                <XCircle size={14} />
              </button>
            </div>
            <ChartState loading={detail.loading} empty={!detail.data} emptyText="No samples for this project yet." height={160}>
              <ProjectResourceCharts resources={detail.data} chartHeight={160} />
            </ChartState>
          </div>
        )}
      </Panel>
    </>
  );
}
