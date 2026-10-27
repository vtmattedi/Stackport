import { Cpu, Loader, RefreshCw } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { api } from "../api/client";
import type { HardwareData } from "../api/types";
import { useChannelData } from "../context/SocketContext";
import { SubShellSectionHeader } from "../components/SubShell";
import { cn } from "../lib/utils";
import { CHART_GRID_COLOR as GRID_COLOR, CHART_TICK as TICK, CHART_TOOLTIP_STYLE as TOOLTIP_STYLE, formatChartTick as formatTick, formatMb, formatPercentValue } from "../lib/charts";
import hardwareStyles from "./Hardware.module.scss";

/** Live and historical usage of the machine Stackport runs on (Host > Hardware). */
export function HardwareSection() {
  const { data, connected, refresh } = useChannelData<HardwareData>("hardware", {
    fallback: () => api.getHardware(24),
  });

  const latest = data?.latest ?? null;

  return (
    <>
      <SubShellSectionHeader
        title="Hardware"
        icon={Cpu}
        description="Live usage of the machine Stackport runs on."
        actions={
          <button className={cn("btn btn-ghost btn-sm", hardwareStyles.refreshBtn)} onClick={refresh} disabled={!data}>
            {data ? <RefreshCw size={13} /> : <Loader size={13} className="spin" />}
            Refresh
          </button>
        }
      />

      <div className={hardwareStyles.statGrid}>
        <div className={hardwareStyles.statCard}>
          <div className={hardwareStyles.statLabel}>CPU usage</div>
          <div className={hardwareStyles.statValue}>{latest ? `${latest.cpuPercent.toFixed(1)}%` : "—"}</div>
          <div className={hardwareStyles.statSub}>{data ? `${data.cpuCount} cores` : ""}</div>
        </div>
        <div className={hardwareStyles.statCard}>
          <div className={hardwareStyles.statLabel}>Memory usage</div>
          <div className={hardwareStyles.statValue}>{latest ? `${latest.memPercent.toFixed(1)}%` : "—"}</div>
          <div className={hardwareStyles.statSub}>
            {latest ? `${formatMb(latest.memUsedMb)} / ${formatMb(latest.memTotalMb)}` : ""}
          </div>
        </div>
        <div className={hardwareStyles.statCard}>
          <div className={hardwareStyles.statLabel}>Load average (1m)</div>
          <div className={hardwareStyles.statValue}>{latest ? latest.load1.toFixed(2) : "—"}</div>
        </div>
        <div className={hardwareStyles.statCard}>
          <div className={hardwareStyles.statLabel}>Status</div>
          <div className={hardwareStyles.statValue} style={{ fontSize: 16, display: "flex", alignItems: "center" }}>
            <span className={cn(hardwareStyles.liveDot, connected && hardwareStyles.liveDotOn)} />
            {connected ? "Live" : "Polling"}
          </div>
          <div className={hardwareStyles.statSub}>{data?.hostname ?? ""}</div>
        </div>
      </div>

      <div className={hardwareStyles.chartsGrid}>
        <div className="card">
          <div className="card-title">CPU % (5-min avg, last 24h)</div>
          <div className={hardwareStyles.chartWrap}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data?.history ?? []} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis dataKey="ts" tick={TICK} tickFormatter={formatTick} minTickGap={40} />
                <YAxis tick={TICK} domain={[0, 100]} width={32} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={formatTick}
                  formatter={formatPercentValue}
                />
                <Line type="monotone" dataKey="cpuAvg" name="CPU avg" stroke="#6366f1" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="cpuMax" name="CPU max" stroke="#f0b429" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Memory % (5-min avg, last 24h)</div>
          <div className={hardwareStyles.chartWrap}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data?.history ?? []} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis dataKey="ts" tick={TICK} tickFormatter={formatTick} minTickGap={40} />
                <YAxis tick={TICK} domain={[0, 100]} width={32} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={formatTick}
                  formatter={formatPercentValue}
                />
                <Line type="monotone" dataKey="memAvg" name="Memory avg" stroke="#3fb950" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="memMax" name="Memory max" stroke="#f85149" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </>
  );
}
