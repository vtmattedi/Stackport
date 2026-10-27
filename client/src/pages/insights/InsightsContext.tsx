import React, { createContext, useCallback, useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalStorageState } from "../../hooks/useLocalStorageState";
import { useSystem } from "../../context/SystemContext";
import type { Project } from "../../api/types";
import type { ProjectPickerItem } from "../../components/ProjectPicker";
import { periodInfo, type PeriodId } from "./shared";
import { DEFAULT_RULES, type RuleId } from "./traffic";

/** Value used in the project filter for StackPort's own domain, which isn't a project row. */
export const STACKPORT_SCOPE = "stackport";

interface InsightsState {
  period: PeriodId;
  setPeriod: (period: PeriodId) => void;
  /** Selected project ids (as strings, plus STACKPORT_SCOPE). Empty = every project. */
  scope: string[];
  setScope: (scope: string[]) => void;
  hideHealthChecks: boolean;
  setHideHealthChecks: (value: boolean) => void;
  maskIps: boolean;
  setMaskIps: (value: boolean) => void;
  rules: Record<RuleId, boolean>;
  setRules: React.Dispatch<React.SetStateAction<Record<RuleId, boolean>>>;
  /** Refetches every Insights query. */
  refresh: () => void;
}

const InsightsContext = createContext<InsightsState | null>(null);

export function InsightsProvider({ children }: { children: React.ReactNode }) {
  const [period, setPeriod] = useLocalStorageState<PeriodId>("insights-period", "24h");
  const [scope, setScope] = useLocalStorageState<string[]>("insights-scope", []);
  const [hideHealthChecks, setHideHealthChecks] = useLocalStorageState("insights-hide-health-checks", true);
  const [maskIps, setMaskIps] = useLocalStorageState("traffic-mask-ips", false);
  const [rules, setRules] = useLocalStorageState<Record<RuleId, boolean>>("traffic-rules", DEFAULT_RULES);
  const queryClient = useQueryClient();
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["insights"] });
  }, [queryClient]);

  const value = useMemo<InsightsState>(() => ({
    period, setPeriod, scope, setScope, hideHealthChecks, setHideHealthChecks,
    maskIps, setMaskIps, rules, setRules, refresh,
  }), [period, setPeriod, scope, setScope, hideHealthChecks, setHideHealthChecks, maskIps, setMaskIps, rules, setRules, refresh]);

  return <InsightsContext.Provider value={value}>{children}</InsightsContext.Provider>;
}

export function useInsights() {
  const ctx = useContext(InsightsContext);
  if (!ctx) throw new Error("useInsights must be used inside InsightsProvider");
  const info = periodInfo(ctx.period);
  return { ...ctx, periodLabel: info.label, days: info.days, hours: info.hours };
}

/**
 * Fetch through the query cache, so moving between sections reuses what's already
 * loaded instead of refetching. `key` must identify the request fully; pass null to skip.
 */
export function useInsightsQuery<T>(key: string | null, fetcher: () => Promise<T>): { data: T | null; loading: boolean; error: boolean } {
  const query = useQuery({
    queryKey: ["insights", key],
    queryFn: fetcher,
    enabled: key !== null,
    staleTime: 60_000,
  });
  return { data: query.data ?? null, loading: key !== null && query.isLoading, error: query.isError };
}

/**
 * Resolves the project filter for both data sources: project ids for container
 * resources, and hostnames for nginx traffic (a project can own several domains).
 */
export function useScope() {
  const { scope } = useInsights();
  const { projects, system } = useSystem();
  const appDomain = system?.nginx?.layer?.app?.domain?.toLowerCase() || null;

  return useMemo(() => {
    const all = projects ?? [];
    const options: ProjectPickerItem[] = all.map((p) => ({ value: String(p.id), label: p.name, group: p.groupName }));
    if (appDomain) options.push({ value: STACKPORT_SCOPE, label: "StackPort", group: "System" });

    const selectedProjects = scope.length > 0 ? all.filter((p) => scope.includes(String(p.id))) : all;
    const projectIds = scope.length > 0 ? selectedProjects.map((p) => p.id) : [];

    let hosts: Set<string> | null = null;
    if (scope.length > 0) {
      hosts = new Set(selectedProjects.flatMap((p) => (p.domains ?? []).map((d) => d.domain.toLowerCase())));
      if (appDomain && scope.includes(STACKPORT_SCOPE)) hosts.add(appDomain);
    }

    const hostOwner = new Map<string, Project>();
    for (const p of all) for (const d of p.domains ?? []) hostOwner.set(d.domain.toLowerCase(), p);

    return {
      options,
      isScoped: scope.length > 0,
      /** Projects in scope (every project when unscoped). */
      projects: selectedProjects,
      /** Ids to pass to resource endpoints; empty = all. */
      projectIds,
      /** Hostnames in scope; null = all traffic, including hosts no project owns. */
      hosts,
      hostOwner,
      appDomain,
    };
  }, [projects, scope, appDomain]);
}
