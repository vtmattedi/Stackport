import React from "react";
import { Squircle, Info, Loader } from "lucide-react";
import { CHART_TOOLTIP_STYLE } from "../../lib/charts";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import styles from "./Insights.module.scss";
import type { LogCoverage } from "../../api/types";

// ── Period ───────────────────────────────────────────────────────────────
export type PeriodId = "24h" | "7d" | "30d";

export const PERIODS: Array<{ value: PeriodId; label: string; days: number; hours: number }> = [
  { value: "24h", label: "24 h", days: 1, hours: 24 },
  { value: "7d", label: "7 d", days: 7, hours: 168 },
  { value: "30d", label: "30 d", days: 30, hours: 720 },
];

/** Container and host samples are only kept for 7 days, so resource charts cap there. */
export const RESOURCE_RETENTION_HOURS = 168;

export function periodInfo(period: PeriodId) {
  return PERIODS.find((p) => p.value === period) ?? PERIODS[0];
}

// ── Colors ───────────────────────────────────────────────────────────────
export const SERIES_COLORS = ["#6366f1", "#3fb950", "#f0b429", "#f85149", "#22d3ee", "#c084fc", "#818cf8", "#fb923c"];
export const STATUS_COLORS = { "2xx": "#3fb950", "3xx": "#6366f1", "4xx": "#f0b429", "5xx": "#f85149" } as const;
export const CURSOR_FILL = "rgba(255,255,255,0.05)";

// ── Formatters ───────────────────────────────────────────────────────────
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function formatDay(date: React.ReactNode): string {
  const d = new Date(String(date));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDateTime(ts: React.ReactNode): string {
  const d = new Date(String(ts));
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${formatDay(ts)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Nginx hour buckets look like "2026-10-24T13:00" (UTC) — show them in local time. */
export function formatHourBucket(ts: React.ReactNode): string {
  const d = new Date(`${String(ts)}:00Z`);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${String(d.getHours()).padStart(2, "0")}h`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// ── Chart chrome ─────────────────────────────────────────────────────────
interface TooltipPayloadItem { name: string; value: number; color: string }

export function SeriesTooltip({ active, payload, label, labelFormatter, valueFormatter }: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  labelFormatter?: (label: string) => string;
  valueFormatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={CHART_TOOLTIP_STYLE}>
      {label && <div style={{ color: "#7d8590", marginBottom: 4 }}>{labelFormatter ? labelFormatter(label) : label}</div>}
      {payload.map((entry) => (
        <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <Squircle size={10} fill={entry.color} color="none" strokeWidth={0} style={{ flexShrink: 0 }} />
          <span style={{ color: "#7d8590" }}>{entry.name}:</span>
          <span>{valueFormatter ? valueFormatter(entry.value) : entry.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export function SeriesLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload?.length) return null;
  return (
    <div className={styles.legend}>
      {payload.map((entry) => (
        <span key={entry.value}>
          <Squircle size={10} fill={entry.color} color="none" strokeWidth={0} style={{ flexShrink: 0 }} />
          {entry.value}
        </span>
      ))}
    </div>
  );
}

// ── Layout pieces ────────────────────────────────────────────────────────
export type Tone = "ok" | "warn" | "bad" | null;

const TONE_CLASS = { ok: styles.toneOk, warn: styles.toneWarn, bad: styles.toneBad } as const;

/** One KPI. `value` is the headline; `total` turns it into an n / total fraction. */
export function StatTile({ label, value, total, sub, tone = null, info, action }: {
  label: string;
  value: React.ReactNode;
  total?: number;
  sub?: React.ReactNode;
  tone?: Tone;
  info?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn(styles.stat, tone && TONE_CLASS[tone])}>
      <div className={styles.statHead}>
        <span className={styles.statLabel}>{label}</span>
        <span className={styles.statTools}>
          {action}
          {info && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className={styles.iconBtn} aria-label={`More about ${label}`}>
                  <Info size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{info}</TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>
      <div className={styles.statValue}>
        <span className={styles.statNumber}>{value}</span>
        {total != null && <span className={styles.statTotal}>/ {total}</span>}
      </div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className={styles.statRow}>{children}</div>;
}

/** A titled card. `meta` sits muted beside the title, `actions` on the right. */
export function Panel({ title, icon: Icon, meta, actions, flush, className, children }: {
  title: React.ReactNode;
  icon?: React.ComponentType<{ size?: number }>;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Drop the body padding (for tables that run edge to edge). */
  flush?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(styles.panel, flush && styles.panelFlush, className)}>
      <header className={styles.panelHead}>
        <span className={styles.panelTitle}>
          {Icon && <Icon size={13} />}
          {title}
          {meta && <span className={styles.panelMeta}>{meta}</span>}
        </span>
        {actions && <span className={styles.panelActions}>{actions}</span>}
      </header>
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

export function ChartState({ loading, empty, emptyText, height = 200, children }: {
  loading: boolean;
  empty: boolean;
  emptyText: string;
  height?: number;
  children: React.ReactNode;
}) {
  if (loading) return <div className={styles.chartPlaceholder} style={{ height }}><Loader size={18} className="spin" /></div>;
  if (empty) return <div className={styles.chartPlaceholder} style={{ height }}>{emptyText}</div>;
  return <div className={styles.chartWrap}>{children}</div>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "bad"; children: React.ReactNode }) {
  return <div className={cn(styles.notice, tone === "bad" && styles.noticeBad)}>{children}</div>;
}

/** Slack before a late first entry counts as missing history rather than a quiet hour. */
const COVERAGE_SLACK_MS = 3600_000;

/**
 * Says when the traffic shown doesn't span the whole chosen period: the read was capped
 * (only the newest requests), the view was cleared, or the log starts later (Docker keeps
 * a few rotated files, and history restarts when the nginx container is recreated).
 */
export function CoverageNote({ coverage, hours, periodLabel }: { coverage: LogCoverage | undefined; hours: number; periodLabel: string }) {
  if (!coverage) return null;
  const periodStart = Date.now() - hours * 3600_000;
  const from = coverage.oldestAt ? formatDateTime(coverage.oldestAt) : null;
  if (coverage.capped) {
    return (
      <Notice>
        Only the most recent requests are read{from ? `, back to ${from}` : ""}. Older traffic in the last {periodLabel} isn't counted.
      </Notice>
    );
  }
  if (coverage.clearedAt) {
    return <Notice>Counting from {formatDateTime(coverage.clearedAt)}, when this view was cleared.</Notice>;
  }
  if (coverage.oldestAt && Date.parse(coverage.oldestAt) > periodStart + COVERAGE_SLACK_MS) {
    return (
      <Notice>
        The log reaches back to {from}. Anything earlier in the last {periodLabel} isn't available (Docker keeps a few
        rotated nginx log files, and history restarts when the nginx container is recreated), or there was no traffic.
      </Notice>
    );
  }
  return null;
}
