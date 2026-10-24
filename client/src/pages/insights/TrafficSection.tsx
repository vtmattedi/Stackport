import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Globe, Radar, Route, ScrollText, ShieldAlert } from "lucide-react";
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { CHART_GRID_COLOR, CHART_TICK } from "../../lib/charts";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { useInsights, useScope, STACKPORT_SCOPE } from "./InsightsContext";
import { useRequestSample, useTraffic } from "./data";
import {
  ChartState, formatBytes, formatDay, formatHourBucket, formatMs, formatPct, Notice, Panel, SeriesLegend,
  SeriesTooltip, StatRow, StatTile, STATUS_COLORS,
} from "./shared";
import { maskIp, splitSeries, statusClasses, statusRates } from "./traffic";
import { HealthCheckToggle } from "./RequestsSection";
import styles from "./Insights.module.scss";

export default function TrafficSection() {
  const { periodLabel, maskIps, setScope } = useInsights();
  const { hostOwner, appDomain } = useScope();
  const traffic = useTraffic();
  const sample = useRequestSample();
  const [expanded, setExpanded] = useState<string | null>(null);

  const t = traffic.totals;
  const rates = statusRates(t.statusCodes);
  const classes = statusClasses(t.statusCodes);
  const series = splitSeries(t.timeSeries);
  const granularity = traffic.data?.granularity ?? "hour";
  const tick = granularity === "day" ? formatDay : formatHourBucket;
  const peak = t.timeSeries.reduce((m, pt) => Math.max(m, pt.count), 0);
  const maxPath = t.topPaths[0]?.count ?? 1;

  // Per-host flagged counts and top IPs come from the recent sample, not the whole window.
  const sampleByHost = useMemo(() => {
    const map = new Map<string, { flagged: number; ips: Map<string, { count: number; flagged: boolean }> }>();
    const flaggedSet = new Set(sample.flagged.map((x) => x.entry));
    for (const e of sample.entries) {
      if (!e.host) continue;
      const host = e.host.toLowerCase();
      const cur = map.get(host) ?? { flagged: 0, ips: new Map() };
      const isFlagged = flaggedSet.has(e);
      if (isFlagged) cur.flagged++;
      const ip = cur.ips.get(e.ip) ?? { count: 0, flagged: false };
      ip.count++;
      if (isFlagged) ip.flagged = true;
      cur.ips.set(e.ip, ip);
      map.set(host, cur);
    }
    return map;
  }, [sample.entries, sample.flagged]);

  function scopeTo(host: string) {
    const owner = hostOwner.get(host);
    if (owner) setScope([String(owner.id)]);
    else if (appDomain && host === appDomain) setScope([STACKPORT_SCOPE]);
  }

  if (traffic.data && !traffic.data.available) {
    return <Notice tone="bad">Nginx access log not available{traffic.data.error ? `: ${traffic.data.error}` : "."}</Notice>;
  }

  return (
    <>
      <div className={styles.sectionTools}>
        <HealthCheckToggle />
      </div>

      <StatRow>
        <StatTile label="Requests" value={traffic.loading ? "—" : t.requests.toLocaleString()} sub={peak > 0 ? `peak ${peak.toLocaleString()} / ${granularity === "hour" ? "hour" : "day"}` : `last ${periodLabel}`} />
        <StatTile
          label="Visitors"
          value={t.uniqueIps == null ? "—" : t.uniqueIps.toLocaleString()}
          sub={t.requests > 0 ? `${formatPct((t.botRequests / t.requests) * 100, 0)} bot traffic` : "unique IPs"}
          info={t.approxLatency ? "Unique IPs are counted per host and summed, so someone who visits two projects counts twice." : undefined}
        />
        <StatTile label="Server errors" value={formatPct(rates.rate5xx)} tone={rates.total === 0 ? null : rates.rate5xx > 1 ? "bad" : "ok"} sub={`${rates.count5xx.toLocaleString()} 5xx`} />
        <StatTile label="Client errors" value={formatPct(rates.rate4xx)} tone={rates.rate4xx > 10 ? "warn" : null} sub="4xx · clients and probes" />
        <StatTile
          label="Latency"
          value={formatMs(t.p95Ms)}
          sub={`P95 · P50 ${formatMs(t.p50Ms)}`}
          info={t.approxLatency ? "Several hosts are selected, so these are request-weighted averages of each host's percentiles." : undefined}
        />
        <StatTile label="Egress" value={formatBytes(t.bytes)} sub={`last ${periodLabel}`} />
      </StatRow>

      <div className={styles.grid21}>
        <Panel title="Requests over time" icon={Radar} meta="by status class">
          <ChartState loading={traffic.loading} empty={t.requests === 0} emptyText="No requests in this window.">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={series} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
                <XAxis dataKey="ts" tick={CHART_TICK} tickFormatter={tick} minTickGap={24} />
                <YAxis tick={CHART_TICK} allowDecimals={false} />
                <Tooltip cursor={{ stroke: CHART_GRID_COLOR }} content={<SeriesTooltip labelFormatter={tick} />} />
                <Area type="monotone" dataKey="ok" name="2xx–3xx" stackId="r" stroke={STATUS_COLORS["2xx"]} fill={STATUS_COLORS["2xx"]} fillOpacity={0.25} />
                <Area type="monotone" dataKey="client" name="4xx" stackId="r" stroke={STATUS_COLORS["4xx"]} fill={STATUS_COLORS["4xx"]} fillOpacity={0.35} />
                <Area type="monotone" dataKey="server" name="5xx" stackId="r" stroke={STATUS_COLORS["5xx"]} fill={STATUS_COLORS["5xx"]} fillOpacity={0.45} />
                <Legend content={<SeriesLegend />} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartState>
        </Panel>

        <Panel title="Status classes">
          {rates.total === 0 ? (
            <div className={styles.emptyText}>No responses yet.</div>
          ) : (
            <>
              <div className={styles.stackBar} role="img" aria-label="Share of responses by status class">
                {classes.filter((c) => c.value > 0).map((c) => (
                  <span key={c.name} style={{ flexGrow: c.value, background: c.color }} />
                ))}
              </div>
              <ul className={styles.classList}>
                {classes.map((c) => (
                  <li key={c.name}>
                    <span className={styles.swatch} style={{ background: c.color }} />
                    <span>{c.name}</span>
                    <span className="mono">{c.value.toLocaleString()}</span>
                    <span className={cn("mono", styles.dim)}>{formatPct((c.value / rates.total) * 100)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>

      <Panel title="By host" icon={Globe} meta="click a row for top paths and sources" flush>
        {traffic.loading ? (
          <ChartState loading empty={false} emptyText="" height={120}>{null}</ChartState>
        ) : t.domains.length === 0 ? (
          <div className={styles.emptyText}>No per-host traffic in this window.</div>
        ) : (
          <div className="table-wrap">
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Host</th>
                  <th className={styles.num}>Requests</th>
                  <th className={cn(styles.num, styles.hideNarrow)}>Visitors</th>
                  <th className={styles.num}>5xx</th>
                  <th className={cn(styles.num, styles.hideNarrow)}>4xx</th>
                  <th className={cn(styles.num, styles.hideNarrow)}>P95</th>
                  <th className={cn(styles.num, styles.hideNarrow)}>Egress</th>
                  <th className={styles.num}>Flagged</th>
                </tr>
              </thead>
              <tbody>
                {t.domains.map((d) => {
                  const host = d.host.toLowerCase();
                  const owner = hostOwner.get(host);
                  const isStackPort = !!appDomain && host === appDomain;
                  const r = statusRates(d.statusCodes);
                  const open = expanded === d.host;
                  const hostSample = sampleByHost.get(host);
                  const topIps = Array.from(hostSample?.ips.entries() ?? []).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
                  const dMax = d.topPaths[0]?.count ?? 1;
                  return (
                    <React.Fragment key={d.host}>
                      <tr className={cn(styles.clickRow, open && styles.clickRowActive)} onClick={() => setExpanded(open ? null : d.host)}>
                        <td>
                          <div className={styles.hostRow}>
                            <ChevronRight size={13} className={cn(styles.chevron, open && styles.chevronOpen)} />
                            <span className={cn(styles.healthDot, (isStackPort || owner?.lastStatus === "up") && styles.healthUp, owner?.lastStatus === "down" && styles.healthDown)} />
                            <span className={styles.hostCell}>
                              <span>{isStackPort ? "StackPort" : owner?.name ?? d.host}</span>
                              {(owner || isStackPort) && <small>{d.host}</small>}
                            </span>
                          </div>
                        </td>
                        <td className={cn("mono", styles.num)}>{d.requests.toLocaleString()}</td>
                        <td className={cn("mono", styles.num, styles.dim, styles.hideNarrow)}>{(d.uniqueIps ?? 0).toLocaleString()}</td>
                        <td className={cn("mono", styles.num)}>
                          <span className={r.rate5xx > 1 ? styles.pillBad : styles.pillMuted}>{r.count5xx.toLocaleString()}</span>
                        </td>
                        <td className={cn("mono", styles.num, styles.dim, styles.hideNarrow)}>{formatPct(r.rate4xx)}</td>
                        <td className={cn("mono", styles.num, styles.dim, styles.hideNarrow)}>{formatMs(d.p95ResponseMs)}</td>
                        <td className={cn("mono", styles.num, styles.dim, styles.hideNarrow)}>{formatBytes(d.bytes)}</td>
                        <td className={styles.num}>
                          {hostSample?.flagged ? <Badge variant="destructive">{hostSample.flagged}</Badge> : <span className={cn("mono", styles.dim)}>0</span>}
                        </td>
                      </tr>
                      {open && (
                        <tr className={styles.detailRow}>
                          <td colSpan={8}>
                            <div className={styles.hostDetail}>
                              <div>
                                <div className={styles.miniTitle}>Top paths</div>
                                {d.topPaths.slice(0, 6).map((p) => (
                                  <div key={p.path} className={styles.barItem}>
                                    <div className={cn("mono", styles.barLabel)}><span className={styles.trunc}>{p.path}</span><span>{p.count.toLocaleString()}</span></div>
                                    <div className={styles.bar}><span style={{ width: `${(p.count / dMax) * 100}%` }} /></div>
                                  </div>
                                ))}
                              </div>
                              <div>
                                <div className={styles.miniTitle}>Top sources (recent sample)</div>
                                {topIps.length === 0 ? <div className={styles.dim}>No sampled requests.</div> : topIps.map(([ip, info]) => (
                                  <div key={ip} className={cn("mono", styles.ipLine, info.flagged && styles.ipFlagged)}>
                                    <span>{maskIp(ip, maskIps)}</span>
                                    <span>{info.count}{info.flagged ? " · flagged" : ""}</span>
                                  </div>
                                ))}
                              </div>
                              <div className={styles.hostActions}>
                                <div className={styles.miniTitle}>Drill in</div>
                                <Link to="/insights/requests" className="btn btn-ghost btn-sm" onClick={() => scopeTo(host)}><ScrollText size={12} />Requests</Link>
                                <Link to="/insights/anomalies" className="btn btn-ghost btn-sm" onClick={() => scopeTo(host)}><ShieldAlert size={12} />Anomalies</Link>
                                {owner && <Link to={`/projects/${owner.id}`} className="btn btn-ghost btn-sm"><Globe size={12} />Project</Link>}
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
        )}
      </Panel>

      <Panel title="Top paths" icon={Route} meta={`all selected hosts, last ${periodLabel}`}>
        {t.topPaths.length === 0 ? (
          <div className={styles.emptyText}>No paths yet.</div>
        ) : (
          <div className={styles.pathGrid}>
            {t.topPaths.slice(0, 12).map((p) => (
              <div key={p.path} className={styles.barItem}>
                <div className={cn("mono", styles.barLabel)}><span className={styles.trunc}>{p.path}</span><span>{p.count.toLocaleString()}</span></div>
                <div className={styles.bar}><span style={{ width: `${(p.count / maxPath) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
