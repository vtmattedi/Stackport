import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, Gauge as GaugeIcon, Loader } from "lucide-react";
import { api } from "../api/client";
import type { HardwareData } from "../api/types";
import { useChannelData, useSocket, useSocketLatency } from "../context/SocketContext";
import { formatBytes, formatRate, formatUptime } from "../lib/format";
import { cn } from "../lib/utils";
import { ActionsPanel, useRunningActions } from "./RunningActions";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import navStyles from "./Nav.module.scss";
import styles from "./StatusStrip.module.scss";

/** Opens on hover (after a short delay) and on click; a click keeps it open until the
 *  pointer leaves or the user clicks elsewhere. */
function HoverPopover({ trigger, children, label, title }: { trigger: ReactNode; children: ReactNode; label: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const schedule = (next: boolean, ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), ms);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const hover = { onMouseEnter: () => schedule(true, 150), onMouseLeave: () => schedule(false, 200) };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(navStyles.navLink, styles.row)} aria-label={label} title={title} {...hover}>
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={6} className={styles.popover} {...hover}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function level(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  return pct >= 90 ? styles.critical : pct >= 75 ? styles.warning : undefined;
}

/** A ring filled to `pct`, with the value inside. */
function RingGauge({ label, pct, sub }: { label: string; pct: number | null; sub?: string }) {
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const filled = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100 * circumference;
  return (
    <div className={styles.gauge}>
      <svg viewBox="0 0 64 64" width={64} height={64} aria-hidden>
        <circle cx={32} cy={32} r={r} className={styles.gaugeTrack} />
        <circle
          cx={32} cy={32} r={r}
          className={cn(styles.gaugeFill, level(pct))}
          strokeDasharray={`${filled} ${circumference}`}
          transform="rotate(-90 32 32)"
        />
        <text x={32} y={36} textAnchor="middle" className={styles.gaugeValue}>{pct === null ? "—" : `${Math.round(pct)}%`}</text>
      </svg>
      <span className={styles.gaugeLabel}>{label}</span>
      {sub && <span className={styles.gaugeSub}>{sub}</span>}
    </div>
  );
}

/** CPU and memory over the last hour (the last twelve 5-minute buckets). */
function Sparkline({ data }: { data: HardwareData["history"] }) {
  const points = data.slice(-12);
  if (points.length < 2) return null;
  const line = (pick: (p: (typeof points)[number]) => number) => points
    .map((p, i) => `${(i / (points.length - 1)) * 200},${40 - (Math.max(0, Math.min(100, pick(p))) / 100) * 40}`)
    .join(" ");
  return (
    <div className={styles.spark}>
      <svg viewBox="0 0 200 40" preserveAspectRatio="none" width="100%" height={40} aria-hidden>
        <polyline points={line((p) => p.memAvg)} className={styles.sparkMem} />
        <polyline points={line((p) => p.cpuAvg)} className={styles.sparkCpu} />
      </svg>
      <span className={styles.sparkLegend}><i className={styles.sparkCpuKey} />CPU <i className={styles.sparkMemKey} />Memory · last hour</span>
    </div>
  );
}

function useHardware(): HardwareData | null {
  return useChannelData<HardwareData>("hardware", { fallback: () => api.getHardware(24) }).data;
}

/** What the machine is doing now: gauges, then the numbers behind them. */
export function HostPanel({ onNavigate }: { onNavigate?: () => void }) {
  const data = useHardware();
  const latest = data?.latest ?? null;
  const disk = data?.disk ?? null;
  const diskPct = disk && disk.totalBytes > 0 ? 100 * (1 - disk.freeBytes / disk.totalBytes) : null;
  return (
    <div className={styles.hostPanel}>
      <div className={styles.gauges}>
        <RingGauge label="CPU" pct={latest?.cpuPercent ?? null} sub={data ? `${data.cpuCount} cores` : undefined} />
        <RingGauge label="Memory" pct={latest?.memPercent ?? null} sub={latest ? `${formatBytes(latest.memUsedMb * 1048576)} used` : undefined} />
        <RingGauge label="Disk" pct={diskPct} sub={disk ? `${formatBytes(disk.freeBytes)} free` : "n/a"} />
      </div>
      <dl className={styles.facts}>
        <dt>Load (1m)</dt><dd>{latest ? latest.load1.toFixed(2) : "—"}</dd>
        <dt>Network</dt>
        <dd>{latest?.netRxBps != null && latest.netTxBps != null ? `↓ ${formatRate(latest.netRxBps)}  ↑ ${formatRate(latest.netTxBps)}` : "n/a"}</dd>
        <dt>Uptime</dt><dd>{data ? formatUptime(data.uptimeS) : "—"}</dd>
        <dt>Host</dt><dd className="mono">{data?.hostname ?? "—"}</dd>
      </dl>
      {data && <Sparkline data={data.history} />}
      <Link to="/host/hardware" className={styles.more} onClick={onNavigate}>Open Hardware</Link>
    </div>
  );
}

function connectionState(connected: boolean, unresponsive: boolean): { label: string; className: string } {
  if (!connected) return { label: "Disconnected", className: styles.dotDown };
  if (unresponsive) return { label: "No response", className: styles.dotWarn };
  return { label: "Connected", className: styles.dotUp };
}

/** The connection to Stackport: a dot, and the latency or the problem. */
export function ConnectionRow({ inMenu = false }: { inMenu?: boolean }) {
  const { connected } = useSocket();
  const latency = useSocketLatency();
  const state = connectionState(connected, latency.unresponsive);
  const text = connected && !latency.unresponsive && latency.ms != null ? `${latency.ms} ms` : state.label;
  const title = latency.unresponsive
    ? "The server stopped answering pings; reconnecting if it doesn't recover"
    : `${state.label}${connected && latency.ms != null ? `, ${latency.ms} ms round trip` : ""}`;
  return (
    <div className={cn(inMenu ? styles.menuRow : cn(navStyles.navLink, styles.row, styles.static))} title={title}>
      <span className={styles.iconBox}><span className={cn(styles.dot, state.className)} /></span>
      <span className={cn(!inMenu && navStyles.linkText, styles.value)}>{text}</span>
    </div>
  );
}

/** Sidebar footer: actions, host and connection, always in the same three rows so the
 *  layout never shifts. */
export function StatusStrip() {
  const running = useRunningActions();
  const data = useHardware();
  const latest = data?.latest ?? null;
  return (
    <div className={styles.strip}>
      <HoverPopover
        label={`${running.length} action${running.length === 1 ? "" : "s"} running`}
        trigger={(
          <>
            <span className={styles.iconBox}>
              {running.length > 0 ? <Loader size={16} className={cn("spin", styles.busy)} /> : <Activity size={16} />}
              <span className={cn(styles.badge, running.length > 0 && styles.badgeOn)} data-strip-badge>{running.length}</span>
            </span>
            <span className={cn(navStyles.linkText, styles.value)}>{running.length > 0 ? `${running.length} running` : "No actions running"}</span>
          </>
        )}
      >
        <ActionsPanel />
      </HoverPopover>

      <HoverPopover
        label="Host usage"
        title={latest ? `CPU ${Math.round(latest.cpuPercent)}% · Memory ${Math.round(latest.memPercent)}%` : undefined}
        trigger={(
          <>
            <span className={styles.iconBox}>
              <GaugeIcon size={16} className={level(latest?.cpuPercent ?? null)} />
              <span className={styles.badge} data-strip-badge>{latest ? Math.round(latest.cpuPercent) : "–"}</span>
            </span>
            <span className={cn(navStyles.linkText, styles.value)}>
              {latest ? `CPU ${Math.round(latest.cpuPercent)}% · MEM ${Math.round(latest.memPercent)}%` : "Host"}
            </span>
          </>
        )}
      >
        <HostPanel />
      </HoverPopover>

      <ConnectionRow />
    </div>
  );
}
