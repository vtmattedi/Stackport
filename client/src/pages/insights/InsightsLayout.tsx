import { BarChart2, LayoutDashboard, Cpu, Radar, ScrollText, ShieldAlert, RefreshCw } from "lucide-react";
import SubShell from "../../components/SubShell";
import { AppSelect } from "../../components/AppSelect";
import { ProjectPicker } from "../../components/ProjectPicker";
import { TooltipProvider } from "../../components/ui/tooltip";
import { InsightsProvider, useInsights, useScope } from "./InsightsContext";
import { useRequestSample } from "./data";
import { PERIODS, type PeriodId } from "./shared";
import styles from "./Insights.module.scss";

export const INSIGHTS_SECTIONS = [
  { path: "overview", label: "Overview", icon: LayoutDashboard },
  { path: "resources", label: "Resources", icon: Cpu },
  { path: "traffic", label: "Traffic", icon: Radar },
  { path: "requests", label: "Requests", icon: ScrollText },
  { path: "anomalies", label: "Anomalies", icon: ShieldAlert },
] as const;

function FilterBar() {
  const { period, setPeriod, scope, setScope, refresh } = useInsights();
  const { options } = useScope();
  return (
    <div className={styles.filterBar}>
      <ProjectPicker items={options} selected={scope} onChange={setScope} triggerClassName={styles.scopeSelect} />
      <AppSelect value={period} onValueChange={(v) => setPeriod(v as PeriodId)} options={PERIODS} triggerClassName={styles.periodSelect} size="sm" />
      <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} title="Reload every section">
        <RefreshCw size={13} />
        <span className={styles.hideNarrow}>Refresh</span>
      </button>
    </div>
  );
}

/** High-severity count from the recent sample, shown on the Anomalies section link. */
function useAnomalyBadge() {
  const { flagged } = useRequestSample();
  const high = flagged.filter((x) => x.flags.some((f) => f.sev === "high")).length;
  return high > 0 ? <span className={styles.sectionBadge}>{high}</span> : null;
}

function InsightsShell() {
  const badge = useAnomalyBadge();
  const sections = INSIGHTS_SECTIONS.map((s) => (s.path === "anomalies" ? { ...s, badge } : s));
  return (
    <SubShell title="Insights" icon={BarChart2} basePath="/insights" sections={sections} actions={<FilterBar />} className={styles.wide} />
  );
}

/** Insights shell: one filter bar (projects + period) shared by every section beside the section list. */
export default function InsightsLayout() {
  return (
    <InsightsProvider>
      <TooltipProvider>
        <InsightsShell />
      </TooltipProvider>
    </InsightsProvider>
  );
}
