import { useMemo } from "react";
import { api } from "../../api/client";
import type { MetricsData, ResourceMetric } from "../../api/types";
import { useInsights, useInsightsQuery, useScope } from "./InsightsContext";
import { RESOURCE_RETENTION_HOURS } from "./shared";
import { flagsFor, LOG_LIMIT, trafficTotals } from "./traffic";

export function useResourceHours() {
  const { hours } = useInsights();
  return Math.min(hours, RESOURCE_RETENTION_HOURS);
}

const NO_DEPLOY_METRICS: MetricsData = {
  deploys: { total: 0, success: 0, failed: 0, byDay: [], recentFailures: [] },
  healthChecks: { projects: [] },
  notifications: { total: 0, success: 0, failed: 0 },
};

export function useDeployMetrics() {
  const { days } = useInsights();
  const { isScoped, projectIds } = useScope();
  // Scoped to StackPort alone: it has no deploys or health checks of its own.
  const none = isScoped && projectIds.length === 0;
  const query = useInsightsQuery(
    none ? null : `metrics:${days}:${projectIds.join(",")}`,
    () => api.getMetrics(days, projectIds),
  );
  return none ? { data: NO_DEPLOY_METRICS, loading: false, error: false } : query;
}

export function useHardware() {
  const hours = useResourceHours();
  return useInsightsQuery(`hardware:${hours}`, () => api.getHardware(hours));
}

export function useResourceSummary() {
  const hours = useResourceHours();
  return useInsightsQuery(`resources:${hours}`, () => api.getProjectResourcesSummary(hours));
}

export function useResourceTimeseries(metric: ResourceMetric) {
  const hours = useResourceHours();
  const { projectIds } = useScope();
  const ids = projectIds.join(",");
  return useInsightsQuery(
    `resources-ts:${hours}:${metric}:${ids}`,
    () => api.getProjectResourcesTimeseries({ hours, metric, projectIds }),
  );
}

export function useProjectResources(projectId: number | null) {
  const hours = useResourceHours();
  return useInsightsQuery(
    projectId == null ? null : `project-resources:${projectId}:${hours}`,
    () => api.getProjectResources(projectId!, hours),
  );
}

/** Aggregated nginx numbers for the period, narrowed to the project filter. */
export function useTraffic() {
  const { period, hideHealthChecks } = useInsights();
  const { hosts } = useScope();
  const query = useInsightsQuery(
    `nginx:${period}:${hideHealthChecks}`,
    () => api.getNginxMetrics({ period, excludeHealthChecks: hideHealthChecks || undefined }),
  );
  const totals = useMemo(() => trafficTotals(query.data, hosts), [query.data, hosts]);
  return { ...query, totals };
}

/** The most recent LOG_LIMIT requests in scope, with anomaly flags applied. */
export function useRequestSample() {
  const { period, hideHealthChecks, rules } = useInsights();
  const { hosts } = useScope();
  // The endpoint filters by one host server-side; for several, fetch everything and filter here.
  const host = hosts && hosts.size === 1 ? [...hosts][0] : undefined;
  const query = useInsightsQuery(
    `nginx-requests:${period}:${hideHealthChecks}:${host ?? "*"}`,
    () => api.getNginxLogEntries({ period, excludeHealthChecks: hideHealthChecks || undefined, host, limit: LOG_LIMIT }),
  );
  const entries = useMemo(() => {
    const all = query.data?.entries ?? [];
    return hosts && !host ? all.filter((e) => e.host != null && hosts.has(e.host.toLowerCase())) : all;
  }, [query.data, hosts, host]);
  const flagged = useMemo(
    () => entries.map((entry) => ({ entry, flags: flagsFor(entry, rules) })).filter((x) => x.flags.length > 0),
    [entries, rules],
  );
  return { ...query, entries, flagged };
}
