import { NavLink, Outlet } from "react-router-dom";
import { BarChart2, LayoutDashboard, Cpu, Radar, ScrollText, ShieldAlert, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils";
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

function SectionNav() {
  const { flagged } = useRequestSample();
  const high = flagged.filter((x) => x.flags.some((f) => f.sev === "high")).length;
  return (
    <nav className={styles.sectionNav} aria-label="Insights sections">
      {INSIGHTS_SECTIONS.map(({ path, label, icon: Icon }) => (
        <NavLink
          key={path}
          to={`/insights/${path}`}
          className={({ isActive }) => cn(styles.sectionLink, isActive && styles.sectionLinkActive)}
        >
          <Icon size={14} />
          {label}
          {path === "anomalies" && high > 0 && <span className={styles.sectionBadge}>{high}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/** Insights shell: one filter bar (projects + period) shared by every section beside the section list. */
export default function InsightsLayout() {
  return (
    <InsightsProvider>
      <TooltipProvider>
        <main className={cn("main", styles.wide)}>
          <div className={styles.header}>
            <h1 className="page-title"><BarChart2 size={18} />Insights</h1>
            <FilterBar />
          </div>
          <div className={styles.shell}>
            <SectionNav />
            <div className={styles.body}>
              <Outlet />
            </div>
          </div>
        </main>
      </TooltipProvider>
    </InsightsProvider>
  );
}
