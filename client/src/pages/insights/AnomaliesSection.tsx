import { useMemo, useState } from "react";
import { ShieldAlert, SlidersHorizontal } from "lucide-react";
import type { NginxLogEntry } from "../../api/types";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { Switch } from "../../components/ui/switch";
import { ExpandableCard } from "../../components/ExpandableCard";
import { useInsights } from "./InsightsContext";
import { useRequestSample } from "./data";
import { ChartState, formatClock, Panel, StatRow, StatTile } from "./shared";
import { LOG_LIMIT, maskIp, RULES, severityVariant, statusColor, type RuleId } from "./traffic";
import { HealthCheckToggle, MaskIpsButton, RequestDetail } from "./RequestsSection";
import styles from "./Insights.module.scss";

const SEV_CLASS = { high: styles.sevHigh, med: styles.sevMed, low: styles.sevLow } as const;

export default function AnomaliesSection() {
  const { maskIps, rules, setRules } = useInsights();
  const sample = useRequestSample();
  const [selected, setSelected] = useState<NginxLogEntry | null>(null);
  const [showRules, setShowRules] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<RuleId, NginxLogEntry[]>();
    for (const { entry, flags } of sample.flagged) {
      for (const f of flags) {
        const list = map.get(f.ruleId) ?? [];
        if (!list.includes(entry)) list.push(entry);
        map.set(f.ruleId, list);
      }
    }
    return RULES.filter((r) => rules[r.id] && map.has(r.id))
      .map((r) => ({ rule: r, items: map.get(r.id) ?? [] }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [sample.flagged, rules]);

  const high = sample.flagged.filter((x) => x.flags.some((f) => f.sev === "high")).length;
  const ips = new Set(sample.flagged.map((x) => x.entry.ip)).size;
  const enabled = RULES.filter((r) => rules[r.id]).length;

  return (
    <>
      <div className={styles.sectionTools}>
        <HealthCheckToggle />
        <MaskIpsButton />
        <button type="button" className={cn("btn btn-sm", showRules ? "btn-primary" : "btn-ghost")} onClick={() => setShowRules((v) => !v)} aria-expanded={showRules}>
          <SlidersHorizontal size={13} />Rules {enabled}/{RULES.length}
        </button>
      </div>

      {showRules && (
        <Panel title="Detection rules" meta="run in your browser over the recent request sample">
          <div className={styles.ruleGrid}>
            {RULES.map((r) => (
              <label key={r.id} className={styles.ruleItem}>
                <span className={cn(styles.sevDot, SEV_CLASS[r.sev])} />
                <span className={styles.ruleText}>
                  <span>{r.label}</span>
                  <small>{r.desc}</small>
                </span>
                <Switch checked={rules[r.id]} onCheckedChange={(v) => setRules((cur) => ({ ...cur, [r.id]: v }))} />
              </label>
            ))}
          </div>
        </Panel>
      )}

      <StatRow>
        <StatTile label="Flagged requests" value={sample.flagged.length} tone={sample.flagged.length > 0 ? "warn" : "ok"} sub={`of the latest ${Math.min(sample.entries.length, LOG_LIMIT)}`} />
        <StatTile label="High severity" value={high} tone={high > 0 ? "bad" : null} />
        <StatTile label="Source IPs" value={ips} sub="behind flagged requests" />
        <StatTile label="Rules on" value={enabled} total={RULES.length} />
      </StatRow>

      {sample.loading ? (
        <ChartState loading empty={false} emptyText="" height={160}>{null}</ChartState>
      ) : groups.length === 0 ? (
        <Panel title="No anomalies" icon={ShieldAlert}>
          <div className={styles.emptyText}>Nothing in the recent sample matches the enabled rules.</div>
        </Panel>
      ) : (
        <div className={styles.groupList}>
          {groups.map(({ rule, items }) => (
            <ExpandableCard
              key={rule.id}
              defaultOpen={rule.sev === "high"}
              title={
                <span className={styles.groupTitle}>
                  <span className={cn(styles.sevDot, SEV_CLASS[rule.sev])} />
                  {rule.label}
                  <Badge variant={severityVariant(rule.sev)}>{rule.sev}</Badge>
                </span>
              }
              summary={<span className={styles.dim}>{items.length} req</span>}
            >
              {items.slice(0, 10).map((e) => (
                <button type="button" key={`${e.time}-${e.ip}-${e.path}`} className={styles.anomalyRow} onClick={() => setSelected(e)}>
                  <span className={styles.dim}>{formatClock(e.time)}</span>
                  <span className={styles.dim}>{maskIp(e.ip, maskIps)}</span>
                  <span className={styles.trunc}>{e.method} {e.host ? <span className={styles.dim}>{e.host}</span> : null}{e.path}</span>
                  <span style={{ color: statusColor(e.status) }}>{e.status}</span>
                </button>
              ))}
              {items.length > 10 && <div className={styles.metaLine}>and {items.length - 10} more. Use Requests → Flagged only to see them all.</div>}
            </ExpandableCard>
          ))}
        </div>
      )}

      {selected && <RequestDetail entry={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
