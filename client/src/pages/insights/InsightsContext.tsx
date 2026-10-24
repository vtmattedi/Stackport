import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSystem } from "../../context/SystemContext";
import type { Project } from "../../api/types";
import { periodInfo, type PeriodId } from "./shared";
import { DEFAULT_RULES, type RuleId } from "./traffic";

export function useLocalStorageState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }, [key, state]);
  return [state, setState];
}

/** Value used in the project filter for StackPort's own domain, which isn't a project row. */
export const STACKPORT_SCOPE = "stackport";

interface CacheEntry { promise: Promise<unknown>; data?: unknown; error?: unknown; settled: boolean }

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
  /** Bumped by Refresh; every query keyed off it refetches. */
  refreshToken: number;
  refresh: () => void;
  cache: React.MutableRefObject<Map<string, CacheEntry>>;
}

const InsightsContext = createContext<InsightsState | null>(null);

export function InsightsProvider({ children }: { children: React.ReactNode }) {
  const [period, setPeriod] = useLocalStorageState<PeriodId>("insights-period", "24h");
  const [scope, setScope] = useLocalStorageState<string[]>("insights-scope", []);
  const [hideHealthChecks, setHideHealthChecks] = useLocalStorageState("insights-hide-health-checks", true);
  const [maskIps, setMaskIps] = useLocalStorageState("traffic-mask-ips", false);
  const [rules, setRules] = useLocalStorageState<Record<RuleId, boolean>>("traffic-rules", DEFAULT_RULES);
  const [refreshToken, setRefreshToken] = useState(0);
  const cache = useRef(new Map<string, CacheEntry>());

  const refresh = useCallback(() => {
    cache.current.clear();
    setRefreshToken((n) => n + 1);
  }, []);

  const value = useMemo<InsightsState>(() => ({
    period, setPeriod, scope, setScope, hideHealthChecks, setHideHealthChecks,
    maskIps, setMaskIps, rules, setRules, refreshToken, refresh, cache,
  }), [period, setPeriod, scope, setScope, hideHealthChecks, setHideHealthChecks, maskIps, setMaskIps, rules, setRules, refreshToken, refresh]);

  return <InsightsContext.Provider value={value}>{children}</InsightsContext.Provider>;
}

export function useInsights() {
  const ctx = useContext(InsightsContext);
  if (!ctx) throw new Error("useInsights must be used inside InsightsProvider");
  const info = periodInfo(ctx.period);
  return { ...ctx, periodLabel: info.label, days: info.days, hours: info.hours };
}

/**
 * Fetch through the shell's cache, so moving between sections reuses what's
 * already loaded instead of refetching. `key` must identify the request fully;
 * pass null to skip.
 */
export function useInsightsQuery<T>(key: string | null, fetcher: () => Promise<T>): { data: T | null; loading: boolean; error: boolean } {
  const { cache, refreshToken } = useInsights();
  const read = useCallback(() => {
    const entry = key ? cache.current.get(key) : undefined;
    return {
      data: (entry?.data as T | undefined) ?? null,
      loading: !!key && !entry?.settled,
      error: !!entry?.error,
    };
  }, [cache, key]);
  const [state, setState] = useState(read);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!key) { setState({ data: null, loading: false, error: false }); return; }
    let entry = cache.current.get(key);
    if (!entry) {
      const created: CacheEntry = { settled: false, promise: Promise.resolve() };
      created.promise = fetcherRef.current()
        .then((data) => { created.data = data; })
        .catch((error: unknown) => { created.error = error ?? true; })
        .finally(() => { created.settled = true; });
      cache.current.set(key, created);
      entry = created;
    }
    setState(read());
    let cancelled = false;
    void entry.promise.then(() => { if (!cancelled) setState(read()); });
    return () => { cancelled = true; };
  }, [cache, key, read, refreshToken]);

  return state;
}

export interface ScopeOption { value: string; label: string }

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
    const options: ScopeOption[] = all.map((p) => ({ value: String(p.id), label: p.name }));
    if (appDomain) options.push({ value: STACKPORT_SCOPE, label: "StackPort" });

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
