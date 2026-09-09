import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import type { ProjectResourceData } from "../api/types";
import { CHART_GRID_COLOR, CHART_TICK, CHART_TOOLTIP_STYLE, formatChartTick, formatMb, formatPercentValue } from "../lib/charts";
import styles from "./ProjectResourceCharts.module.scss";

function formatMbValue(value: unknown): string {
  return typeof value === "number" ? formatMb(value) : "—";
}

/** CPU / memory / network / disk-size history charts for a project's docker compose stack — shared by ProjectDetails and the Metrics resource-usage drill-down. */
export function ProjectResourceCharts({ resources, chartHeight = 180 }: { resources: ProjectResourceData | null; chartHeight?: number }) {
  const diskHistory = (resources?.diskSize.history ?? []).map((point) => ({ ts: point.ts, sizeMb: point.sizeBytes / (1024 * 1024) }));

  return (
    <div className={styles.chartsGrid}>
      <div className={styles.chartWrap}>
        <div className={styles.chartTitle}>CPU %</div>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <LineChart data={resources?.history ?? []} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
            <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={formatChartTick} minTickGap={40} />
            <YAxis tick={CHART_TICK} width={32} />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={formatChartTick} formatter={formatPercentValue} />
            <Line type="monotone" dataKey="cpuAvg" name="CPU avg" stroke="#6366f1" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="cpuMax" name="CPU max" stroke="#f0b429" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.chartWrap}>
        <div className={styles.chartTitle}>Memory %</div>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <LineChart data={resources?.history ?? []} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
            <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={formatChartTick} minTickGap={40} />
            <YAxis tick={CHART_TICK} domain={[0, 100]} width={32} />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={formatChartTick} formatter={formatPercentValue} />
            <Line type="monotone" dataKey="memAvg" name="Memory avg" stroke="#3fb950" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="memMax" name="Memory max" stroke="#f85149" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.chartWrap}>
        <div className={styles.chartTitle}>Network (per 5-min window)</div>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <LineChart data={resources?.history ?? []} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
            <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={formatChartTick} minTickGap={40} />
            <YAxis tick={CHART_TICK} width={40} />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={formatChartTick} formatter={formatMbValue} />
            <Line type="monotone" dataKey="netRxMb" name="Received" stroke="#22d3ee" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="netTxMb" name="Sent" stroke="#818cf8" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.chartWrap}>
        <div className={styles.chartTitle}>Disk size</div>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <LineChart data={diskHistory} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
            <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={formatChartTick} minTickGap={40} />
            <YAxis tick={CHART_TICK} width={40} />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={formatChartTick} formatter={formatMbValue} />
            <Line type="monotone" dataKey="sizeMb" name="Disk size" stroke="#c084fc" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
