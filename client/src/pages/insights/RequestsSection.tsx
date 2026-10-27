import React, { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock, Copy, Eye, EyeOff, Filter, Search, X } from "lucide-react";
import type { NginxLogEntry } from "../../api/types";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import { AppSelect } from "../../components/AppSelect";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
import { useInsights } from "./InsightsContext";
import { useRequestSample } from "./data";
import { ChartState, formatClock, formatMs, Notice } from "./shared";
import { flagsFor, LOG_LIMIT, maskIp, severityVariant, statusColor } from "./traffic";
import styles from "./Insights.module.scss";

export function HealthCheckToggle() {
  const { hideHealthChecks, setHideHealthChecks } = useInsights();
  return (
    <label className={styles.toggle} title="Leave out StackPort's own health-check requests">
      <Switch size="sm" checked={hideHealthChecks} onCheckedChange={setHideHealthChecks} />
      <span>Hide health checks</span>
    </label>
  );
}

export function MaskIpsButton() {
  const { maskIps, setMaskIps } = useInsights();
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMaskIps(!maskIps)} title="Hide the last part of client IPs">
      {maskIps ? <EyeOff size={13} /> : <Eye size={13} />}
      {maskIps ? "IPs masked" : "Mask IPs"}
    </button>
  );
}

/** Full detail for one sampled request, with jump-offs to filter or block its IP. */
export function RequestDetail({ entry, onClose }: { entry: NginxLogEntry; onClose: () => void }) {
  const { maskIps, rules } = useInsights();
  const navigate = useNavigate();
  const flags = flagsFor(entry, rules);
  const raw = `${entry.ip} - - [${new Date(entry.time).toISOString()}] "${entry.method} ${entry.path} HTTP/1.1" ${entry.status} ${entry.bytes} "-" "${entry.ua ?? "-"}" "${entry.host ?? "-"}" ${entry.requestTimeMs != null ? (entry.requestTimeMs / 1000).toFixed(3) : "-"}`;
  const rows: Array<[string, React.ReactNode]> = [
    ["Host", entry.host ?? "—"],
    ["Client IP", maskIp(entry.ip, maskIps)],
    ["Method", entry.method],
    ["Path", entry.path],
    ["Status", <span style={{ color: statusColor(entry.status) }}>{entry.status}</span>],
    ["Request time", formatMs(entry.requestTimeMs)],
    ["Bytes sent", entry.bytes.toLocaleString()],
    ["User-agent", entry.ua || "—"],
  ];

  async function copyIp() {
    try {
      await navigator.clipboard.writeText(entry.ip);
      notify.success(`${entry.ip} copied.`);
    } catch (err) {
      notify.error(err, "Couldn't copy the IP");
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-panel">
        <div className={styles.modalHead}>
          <span>Request detail</span>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {flags.length > 0 && (
          <div className={styles.flagBanner}>
            <div>Flagged by {flags.length} rule{flags.length > 1 ? "s" : ""}</div>
            <div className={styles.badges}>{flags.map((f) => <Badge key={f.label} variant={severityVariant(f.sev)}>{f.label}</Badge>)}</div>
          </div>
        )}
        <div className={styles.kvList}>
          {rows.map(([k, v]) => (
            <div key={k} className={styles.kvRow}><span>{k}</span><span className="mono">{v}</span></div>
          ))}
        </div>
        <div className={styles.miniTitle} style={{ margin: "12px 0 4px" }}>Raw log line</div>
        <div className="output-block">{raw}</div>
        <div className={styles.modalActions}>
          <button type="button" className="btn btn-ghost" onClick={() => { onClose(); navigate(`/insights/requests?q=${encodeURIComponent(entry.ip)}`); }}>
            <Search size={13} />Filter this IP
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void copyIp()}>
            <Copy size={13} />Copy IP
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_FILTERS = [
  { value: "all", label: "Any status" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
];

export default function RequestsSection() {
  const { maskIps, rules } = useInsights();
  const sample = useRequestSample();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const [method, setMethod] = useState("all");
  const [statusClass, setStatusClass] = useState("all");
  const [slowOnly, setSlowOnly] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selected, setSelected] = useState<NginxLogEntry | null>(null);

  function setSearch(q: string) {
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      if (q) next.set("q", q); else next.delete("q");
      return next;
    }, { replace: true });
  }

  const methodOptions = useMemo(() => {
    const methods = Array.from(new Set(sample.entries.map((e) => e.method))).sort();
    return [{ value: "all", label: "Any method" }, ...methods.map((m) => ({ value: m, label: m }))];
  }, [sample.entries]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sample.entries
      .map((entry) => ({ entry, flags: flagsFor(entry, rules) }))
      .filter(({ entry: e, flags }) => {
        if (q && !`${e.ip} ${e.method} ${e.path} ${e.host ?? ""} ${e.ua ?? ""}`.toLowerCase().includes(q)) return false;
        if (method !== "all" && e.method !== method) return false;
        if (statusClass !== "all" && `${Math.floor(e.status / 100)}xx` !== statusClass) return false;
        if (slowOnly && (e.requestTimeMs == null || e.requestTimeMs < 1000)) return false;
        if (flaggedOnly && flags.length === 0) return false;
        return true;
      });
  }, [sample.entries, search, method, statusClass, slowOnly, flaggedOnly, rules]);

  return (
    <>
      <div className={styles.sectionTools}>
        <HealthCheckToggle />
        <MaskIpsButton />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Search size={13} />
          <input placeholder="Search IP, path, host, user-agent…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <AppSelect value={method} onValueChange={setMethod} options={methodOptions} triggerClassName={styles.filterSelect} size="sm" />
        <AppSelect value={statusClass} onValueChange={setStatusClass} options={STATUS_FILTERS} triggerClassName={styles.filterSelect} size="sm" />
        <button type="button" className={cn("btn btn-sm", slowOnly ? "btn-primary" : "btn-ghost")} onClick={() => setSlowOnly((v) => !v)} aria-pressed={slowOnly}>
          <Clock size={12} />Slow &gt;1s
        </button>
        <button type="button" className={cn("btn btn-sm", flaggedOnly ? "btn-primary" : "btn-ghost")} onClick={() => setFlaggedOnly((v) => !v)} aria-pressed={flaggedOnly}>
          <Filter size={12} />Flagged only
        </button>
      </div>

      <div className={styles.metaLine}>
        {rows.length.toLocaleString()} of {sample.entries.length.toLocaleString()} requests
        {sample.data?.truncated ? ` · the most recent ${LOG_LIMIT} in this window` : ""}
      </div>

      {sample.data && !sample.data.available ? (
        <Notice tone="bad">{sample.data.error ?? "Nginx access log not found."}</Notice>
      ) : (
        <div className={styles.logCard}>
          {sample.loading ? (
            <ChartState loading empty={false} emptyText="" height={160}>{null}</ChartState>
          ) : rows.length === 0 ? (
            <div className={styles.emptyText}>No requests match these filters.</div>
          ) : (
            <>
              <div className={cn(styles.logRow, styles.logHead)}>
                <span>Time</span><span>Client</span><span>Method</span><span>Host / path</span><span>Status</span><span className={styles.hideNarrow}>Time</span><span>Flags</span>
              </div>
              {rows.map(({ entry: e, flags }) => (
                <button
                  type="button"
                  key={`${e.time}-${e.ip}-${e.path}-${e.status}`}
                  className={cn(styles.logRow, flags.some((f) => f.sev === "high") && styles.logRowFlagged)}
                  onClick={() => setSelected(e)}
                >
                  <span className={styles.dim}>{formatClock(e.time)}</span>
                  <span className={cn(styles.trunc, styles.dim)}>{maskIp(e.ip, maskIps)}</span>
                  <span className={styles.method} data-method={e.method}>{e.method}</span>
                  <span className={styles.trunc}>
                    {e.host && <span className={styles.dim}>{e.host}</span>}
                    {e.path}
                  </span>
                  <span style={{ color: statusColor(e.status) }}>{e.status}</span>
                  <span className={cn(styles.dim, styles.hideNarrow)}>{formatMs(e.requestTimeMs)}</span>
                  <span className={styles.badges}>
                    {flags.slice(0, 2).map((f) => <Badge key={f.label} variant={severityVariant(f.sev)}>{f.label}</Badge>)}
                    {flags.length > 2 && <span className={styles.dim}>+{flags.length - 2}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {selected && <RequestDetail entry={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
