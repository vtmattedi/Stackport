import { useState } from "react";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, CheckCircle2, Loader, Radar, RefreshCw } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { api } from "../../api/client";
import type { NginxDomainStat } from "../../api/types";
import { CHART_GRID_COLOR, CHART_TICK } from "../../lib/charts";
import { TimeAgo } from "../../components/TimeAgo";
import { useInsights, useScope } from "./InsightsContext";
import { useDeployMetrics, useHardware, useRequestSample, useTraffic } from "./data";
import {
  ChartState, CURSOR_FILL, formatDay, formatHourBucket, formatMs, formatPct, Panel, SeriesLegend,
  SeriesTooltip, StatRow, StatTile, STATUS_COLORS,
} from "./shared";
import { splitSeries, statusRates } from "./traffic";
import styles from "./Insights.module.scss";

/** 5xx share per project, so a project serving several domains shows up once. */
function serverErrorsByOwner(domains: NginxDomainStat[], ownerOf: (host: string) => string) {
  const byOwner = new Map<string, { requests: number; count: number }>();
  for (const d of domains) {
    const name = ownerOf(d.host.toLowerCase());
    const cur = byOwner.get(name) ?? { requests: 0, count: 0 };
    const r = statusRates(d.statusCodes);
    cur.requests += r.total;
    cur.count += r.count5xx;
    byOwner.set(name, cur);
  }
  return Array.from(byOwner, ([name, v]) => ({ name, count: v.count, rate: v.requests ? (v.count / v.requests) * 100 : 0 }))
    .sort((a, b) => b.rate - a.rate);
}

interface AttentionItem { key: string; tone: "bad" | "warn"; text: React.ReactNode; to: string }

export default function OverviewSection() {
  const { periodLabel, refresh } = useInsights();
  const { isScoped, hostOwner } = useScope();
  const deploys = useDeployMetrics();
  const traffic = useTraffic();
  const hardware = useHardware();
  const sample = useRequestSample();
  const [checking, setChecking] = useState(false);

  const metrics = deploys.data;
  const health = metrics?.healthChecks.projects ?? [];
  const down = health.filter((p) => p.status !== "up");
  const rates = statusRates(traffic.totals.statusCodes);
  const latest = hardware.data?.latest ?? null;
  const series = splitSeries(traffic.totals.timeSeries);
  const granularity = traffic.data?.granularity ?? "hour";
  const tickFormatter = granularity === "day" ? formatDay : formatHourBucket;

  async function recheckAll() {
    setChecking(true);
    await Promise.allSettled(health.map((p) => api.checkProject(p.id)));
    setChecking(false);
    refresh();
  }

  const attention: AttentionItem[] = [
    ...down.map((p) => ({
      key: `hc-${p.id}`, tone: "bad" as const, to: `/projects/${p.id}`,
      text: <><strong>{p.name}</strong> health check is failing <span className={styles.dim}>· checked <TimeAgo ts={p.lastCheckedAt} fallback="never" /></span></>,
    })),
    ...(metrics?.deploys.recentFailures ?? []).slice(0, 5).map((f) => ({
      key: `dep-${f.id}`, tone: "warn" as const, to: `/projects/${f.projectId}`,
      text: <><strong>{f.projectName}</strong> deploy failed <span className={styles.dim}>· <TimeAgo ts={f.createdAt} /></span></>,
    })),
    ...serverErrorsByOwner(traffic.totals.domains, (host) => hostOwner.get(host)?.name ?? host)
      .filter((o) => o.rate > 1)
      .map((o) => ({
        key: `5xx-${o.name}`, tone: "bad" as const, to: "/insights/traffic",
        text: <><strong>{o.name}</strong> is returning {formatPct(o.rate)} server errors <span className={styles.dim}>· {o.count.toLocaleString()} in {periodLabel}</span></>,
      })),
  ];
  const highFlags = sample.flagged.filter((x) => x.flags.some((f) => f.sev === "high")).length;
  if (highFlags > 0) {
    attention.push({
      key: "anomalies", tone: "warn", to: "/insights/anomalies",
      text: <><strong>{highFlags}</strong> high-severity request{highFlags > 1 ? "s" : ""} in the latest sample</>,
    });
  }

  return (
    <>
      <StatRow>
        <StatTile
          label="Health checks"
          value={health.filter((p) => p.status === "up").length}
          total={health.length}
          tone={health.length === 0 ? null : down.length === 0 ? "ok" : "bad"}
          sub={health.length === 0 ? "None configured" : down.length > 0 ? `${down.length} failing` : "All passing"}
          action={health.length > 0 && (
            <button type="button" className={styles.iconBtn} onClick={() => void recheckAll()} disabled={checking} title="Recheck all now">
              {checking ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
            </button>
          )}
        />
        <StatTile
          label="Deploys"
          value={metrics?.deploys.success ?? "—"}
          total={metrics?.deploys.total}
          tone={!metrics || metrics.deploys.total === 0 ? null : metrics.deploys.failed === 0 ? "ok" : "warn"}
          sub={!metrics ? " " : metrics.deploys.total === 0 ? `None in ${periodLabel}` : metrics.deploys.failed > 0 ? `${metrics.deploys.failed} failed` : "All succeeded"}
        />
        <StatTile
          label="Requests"
          value={traffic.loading ? "—" : traffic.totals.requests.toLocaleString()}
          sub={`last ${periodLabel}`}
        />
        <StatTile
          label="Server errors"
          value={traffic.loading ? "—" : formatPct(rates.rate5xx)}
          tone={rates.total === 0 ? null : rates.rate5xx > 1 ? "bad" : "ok"}
          sub={`${rates.count5xx.toLocaleString()} 5xx responses`}
        />
        <StatTile label="P95 latency" value={formatMs(traffic.totals.p95Ms)} sub={traffic.totals.approxLatency ? "weighted across hosts" : "nginx request time"} />
        <StatTile
          label="Host load"
          value={latest ? formatPct(latest.cpuPercent, 0) : "—"}
          tone={!latest ? null : latest.cpuPercent > 85 || latest.memPercent > 90 ? "bad" : latest.cpuPercent > 60 || latest.memPercent > 75 ? "warn" : null}
          sub={latest ? `CPU · memory ${formatPct(latest.memPercent, 0)}` : "No samples yet"}
          info={isScoped ? "The whole server, not just the selected projects." : undefined}
        />
      </StatRow>

      <Panel title="Needs attention" icon={AlertTriangle} meta={attention.length > 0 ? String(attention.length) : undefined}>
        {deploys.loading && traffic.loading ? (
          <div className={styles.placeholderRow}><Loader size={16} className="spin" /></div>
        ) : attention.length === 0 ? (
          <div className={styles.allClear}><CheckCircle2 size={15} />Nothing needs you right now.</div>
        ) : (
          <ul className={styles.attentionList}>
            {attention.map((item) => (
              <li key={item.key}>
                <Link to={item.to} className={styles.attentionItem}>
                  <span className={item.tone === "bad" ? styles.dotBad : styles.dotWarn} />
                  <span>{item.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className={styles.grid2}>
        <Panel title="Requests" icon={Radar} meta={`last ${periodLabel}`} actions={<Link to="/insights/traffic" className={styles.panelLink}>Traffic →</Link>}>
          <ChartState loading={traffic.loading} empty={series.every((p) => p.ok + p.client + p.server === 0)} emptyText={traffic.data?.available === false ? "Nginx access log not available." : "No requests in this window."}>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={series} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
                <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={tickFormatter} minTickGap={24} />
                <YAxis tick={CHART_TICK} allowDecimals={false} />
                <Tooltip cursor={{ stroke: CHART_GRID_COLOR }} content={<SeriesTooltip labelFormatter={tickFormatter} />} />
                <Area type="monotone" dataKey="ok" name="2xx–3xx" stackId="r" stroke={STATUS_COLORS["2xx"]} fill={STATUS_COLORS["2xx"]} fillOpacity={0.25} />
                <Area type="monotone" dataKey="client" name="4xx" stackId="r" stroke={STATUS_COLORS["4xx"]} fill={STATUS_COLORS["4xx"]} fillOpacity={0.35} />
                <Area type="monotone" dataKey="server" name="5xx" stackId="r" stroke={STATUS_COLORS["5xx"]} fill={STATUS_COLORS["5xx"]} fillOpacity={0.45} />
                <Legend content={<SeriesLegend />} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartState>
        </Panel>

        <Panel title="Deploys" icon={Activity} meta={`last ${periodLabel}`}>
          <ChartState loading={deploys.loading} empty={!metrics || metrics.deploys.byDay.length === 0} emptyText="No deploys in this window.">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={metrics?.deploys.byDay ?? []} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDay} tick={CHART_TICK} />
                <YAxis tick={CHART_TICK} allowDecimals={false} />
                <Tooltip cursor={{ fill: CURSOR_FILL }} content={<SeriesTooltip labelFormatter={formatDay} />} />
                <Bar dataKey="success" name="Succeeded" stackId="d" fill={STATUS_COLORS["2xx"]} maxBarSize={36} />
                <Bar dataKey="failed" name="Failed" stackId="d" fill={STATUS_COLORS["5xx"]} radius={[2, 2, 0, 0]} maxBarSize={36} />
                <Legend content={<SeriesLegend />} />
              </BarChart>
            </ResponsiveContainer>
          </ChartState>
        </Panel>
      </div>

      {health.length > 0 && (
        <Panel title="Health checks" icon={CheckCircle2} flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Project</th><th>Status</th><th>Response</th><th>Last checked</th></tr>
              </thead>
              <tbody>
                {health.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/projects/${p.id}`} className={styles.rowLink}>{p.name}</Link></td>
                    <td><span className={p.status === "up" ? styles.pillOk : p.status === "down" ? styles.pillBad : styles.pillMuted}>{p.status}</span></td>
                    <td className="mono">{formatMs(p.lastResponseMs)}</td>
                    <td className={styles.dim}><TimeAgo ts={p.lastCheckedAt} fallback="never" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
