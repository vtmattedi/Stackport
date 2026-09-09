import { useState } from "react";
import {
  AlertCircle, Cpu, HardDrive, Loader, MemoryStick, Monitor, Network,
  PowerOff, RefreshCw, Server,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { api, ApiError } from "../api/client";
import type { HardwareData, MonitoredVm, VmData, VpsData } from "../api/types";
import { useChannelData } from "../context/SocketContext";
import { useConfirm } from "../components/ConfirmDialog";
import { formatShortDateTime } from "../lib/format";
import { cn } from "../lib/utils";
import { notify } from "../lib/notify";
import { CHART_GRID_COLOR as GRID_COLOR, CHART_TICK as TICK, CHART_TOOLTIP_STYLE as TOOLTIP_STYLE, formatChartTick as formatTick, formatMb, formatPercentValue } from "../lib/charts";
import vpsStyles from "./Vps.module.scss";
import hardwareStyles from "./Hardware.module.scss";

function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function fmtUptime(sec: number): string {
  if (!sec) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function MetricBar({ pct, color }: { pct: number; color: string }) {
  const safeColor = pct >= 90 ? "var(--danger)" : pct >= 70 ? "#fb923c" : color;
  return (
    <div className={vpsStyles.mbarTrack}>
      <div className={vpsStyles.mbarFill} style={{ width: `${Math.min(100, pct)}%`, background: safeColor }} />
    </div>
  );
}

function MetricCard({ icon, label, value, pct, sub, iconColor }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  pct?: number;
  sub: string;
  iconColor: string;
}) {
  return (
    <div className={vpsStyles.metricCard}>
      <div className={vpsStyles.metricCardHeader}>
        <div className={vpsStyles.metricCardLabel} style={{ color: iconColor }}>
          {icon}
          <span>{label}</span>
        </div>
        <span className={vpsStyles.metricCardValue}>{value}</span>
      </div>
      {pct !== undefined && <MetricBar pct={pct} color={iconColor} />}
      <p className={vpsStyles.metricCardSub}>{sub}</p>
    </div>
  );
}

function VmCard({ vm, monitored }: {
  vm: VmData;
  monitored?: MonitoredVm;
}) {
  const confirm = useConfirm();
  const [resetting, setResetting] = useState(false);
  const cpuPct = vm.cpu?.pct ?? 0;
  const ramPct = vm.ram?.totalBytes ? Math.round((vm.ram.bytes / vm.ram.totalBytes) * 100) : 0;
  const diskPct = vm.disk?.totalBytes ? Math.round((vm.disk.bytes / vm.disk.totalBytes) * 100) : 0;
  const label = monitored?.label || vm.hostname || `VM ${vm.id ?? ""}`;

  async function handleReset() {
    if (vm.providerId == null || vm.id == null) return;
    const ok = await confirm({
      title: `Reset ${label}?`,
      description: "This will perform a hard reset of the VPS. The server will be rebooted immediately.",
      confirmLabel: "Reset VPS",
      destructive: true,
    });
    if (!ok) return;
    setResetting(true);
    const toastId = notify.loading(`Resetting ${label}...`);
    try {
      await api.resetVm(vm.providerId, String(vm.id));
      notify.success(`${label} reset triggered.`, { id: toastId });
    } catch (err) {
      notify.error(err instanceof ApiError ? new Error(err.message) : err, `Failed to reset ${label}`, { id: toastId });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="card">
      <div className={vpsStyles.vpsInfoBar} style={{ marginBottom: 14 }}>
        <div className={vpsStyles.vpsInfoDot} />
        <div className={vpsStyles.vpsInfoText}>
          <span className={vpsStyles.vpsHostname}>{label}</span>
          <span className={vpsStyles.vpsPlan}>
            {[vm.plan, vm.cpus ? `${vm.cpus} vCPU` : null,
              vm.ram?.totalBytes ? `${fmtBytes(vm.ram.totalBytes)} RAM` : null,
              vm.disk?.totalBytes ? `${fmtBytes(vm.disk.totalBytes)} disk` : null,
            ].filter(Boolean).join(" | ")}
          </span>
          {vm.ipAddresses && vm.ipAddresses.length > 0 && (
            <span className={cn(vpsStyles.vpsPlan, "mono")}>{vm.ipAddresses.join(" | ")}</span>
          )}
        </div>
        <span className={vpsStyles.vpsStateBadge}>{vm.state ?? "unknown"}</span>
      </div>

      <div className={vpsStyles.metricsGrid}>
        <MetricCard icon={<Cpu size={15} />} label="CPU" value={`${cpuPct.toFixed(1)}%`} pct={cpuPct} sub={`${vm.cpus ?? 1} vCPU`} iconColor="#fb923c" />
        <MetricCard icon={<MemoryStick size={15} />} label="RAM" value={`${ramPct}%`} pct={ramPct} sub={`${fmtBytes(vm.ram?.bytes ?? 0)} / ${fmtBytes(vm.ram?.totalBytes ?? 0)}`} iconColor="#60a5fa" />
        <MetricCard icon={<HardDrive size={15} />} label="Disk" value={`${diskPct}%`} pct={diskPct} sub={`${fmtBytes(vm.disk?.bytes ?? 0)} / ${fmtBytes(vm.disk?.totalBytes ?? 0)}`} iconColor="#c084fc" />
        <MetricCard icon={<Network size={15} />} label="Network In" value={fmtBytes(vm.network?.inBytes ?? 0)} sub="Last hour" iconColor="#22d3ee" />
        <MetricCard icon={<Network size={15} />} label="Network Out" value={fmtBytes(vm.network?.outBytes ?? 0)} sub="Last hour" iconColor="#818cf8" />
        <MetricCard icon={<Server size={15} />} label="Uptime" value={fmtUptime(vm.uptimeSec ?? 0)} sub={`VM ${vm.id ?? ""}`} iconColor="#4ade80" />
      </div>

      <div className={vpsStyles.vpsFooter}>
        <span>Updated {formatShortDateTime(vm.fetchedAt, "never")}</span>
        {vm.providerId != null && vm.id != null && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-danger"
            onClick={() => void handleReset()}
            disabled={resetting}
            title="Hard reset this VPS"
          >
            {resetting ? <Loader size={12} className="spin" /> : <PowerOff size={12} />}
            Reset VPS
          </button>
        )}
      </div>
    </div>
  );
}

function VpsSection() {
  const { data, refresh } = useChannelData<VpsData>("vps", { fallback: () => api.getVm() });
  const loading = data === null;
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const monitored = data?.monitored ?? [];
  const vms = data?.vms ?? [];
  const lastFetchedAt = vms
    .map((vm) => vm.fetchedAt ? new Date(vm.fetchedAt).getTime() : 0)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  async function refreshVms() {
    setRefreshing(true);
    setError("");
    try {
      await api.refreshVps();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to refresh VMs");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1 className="page-title" style={{ fontSize: 16, marginBottom: 0 }}><Monitor size={17} />VPS</h1>
        <div className="row-actions">
          <span className="text-foreground-muted" style={{ marginRight: 12 }}>
            Data time: {lastFetchedAt ? formatShortDateTime(new Date(lastFetchedAt).toISOString(), "never") : "never"}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => void refreshVms()} disabled={loading || refreshing || monitored.length === 0}>
            {refreshing ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
            Force refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error"><AlertCircle size={14} />{error}</div>}

      {loading ? (
        <div className={cn("card", vpsStyles.vpsSkeleton)}>Loading...</div>
      ) : vms.length > 0 ? (
        vms.map((vm) => (
          <VmCard
            key={`${vm.providerId ?? "unknown"}:${String(vm.id)}`}
            vm={vm}
            monitored={monitored.find((item) => item.providerId === vm.providerId && item.vmId === String(vm.id))}
          />
        ))
      ) : (
        <div className="card empty">No VM state yet. Add monitored VMs in Settings, then refresh VMs.</div>
      )}
    </section>
  );
}

function HardwareSection() {
  const { data, connected, refresh } = useChannelData<HardwareData>("hardware", {
    fallback: () => api.getHardware(24),
  });

  const latest = data?.latest ?? null;

  return (
    <section>
      <div className="page-header">
        <h1 className="page-title" style={{ fontSize: 16, marginBottom: 0 }}>
          <Cpu size={17} />
          Local host
        </h1>
        <button className={cn("btn btn-ghost btn-sm", hardwareStyles.refreshBtn)} onClick={refresh} disabled={!data}>
          {data ? <RefreshCw size={13} /> : <Loader size={13} className="spin" />}
          Refresh
        </button>
      </div>

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
    </section>
  );
}

export default function Infrastructure() {
  return (
    <main className="main">
      <div className="page-header">
        <h1 className="page-title">
          <Monitor size={18} style={{ display: "inline", marginRight: 8, verticalAlign: "text-bottom" }} />
          Infrastructure
        </h1>
      </div>
      <VpsSection />
      <div style={{ height: 24 }} />
      <HardwareSection />
    </main>
  );
}
