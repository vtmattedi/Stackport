import { useCallback, useEffect } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { api } from "../../api/client";
import type {
  ActionSummary,
  Credential,
  Project,
  ProjectDeploy,
  ProjectDeploymentRevision,
  ProjectDomain,
  ProjectEnvFile,
  ProjectUpdateEvent,
  TcpExposure,
} from "../../api/types";
import { useRunningActionRecords } from "../../context/ActionTracker";
import { useSocket } from "../../context/SocketContext";
import { queryClient } from "../../lib/queryClient";
import { queryKeys } from "../../lib/queryKeys";

type Updater<T> = T | ((current: T) => T);

/** A setter over a query's cached value, shaped like useState's, for code that
 *  updates local data after a mutation. */
function cacheSetter<T>(key: QueryKey, fallback: T): (next: Updater<T>) => void {
  return (next) => {
    queryClient.setQueryData<T>(key, (current) => {
      const base = current ?? fallback;
      return typeof next === "function" ? (next as (c: T) => T)(base) : next;
    });
  };
}

const EMPTY: never[] = [];

/** The project, kept live by the server's project:update pushes. */
export function useProjectQuery(projectId: number) {
  const valid = Number.isInteger(projectId) && projectId > 0;
  const { subscribeProject, unsubscribeProject } = useSocket();
  const query = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
    enabled: valid,
  });

  useEffect(() => {
    if (!valid) return;
    const handler = (event: ProjectUpdateEvent) => {
      if (event.projectId === projectId) queryClient.setQueryData(queryKeys.project(projectId), event.project);
    };
    subscribeProject<ProjectUpdateEvent>(projectId, handler);
    return () => unsubscribeProject<ProjectUpdateEvent>(projectId, handler);
  }, [projectId, valid, subscribeProject, unsubscribeProject]);

  const setProject = useCallback(
    (next: Updater<Project | null>) => cacheSetter<Project | null>(queryKeys.project(projectId), null)(next),
    [projectId],
  );
  return { project: query.data ?? null, isLoading: query.isLoading, error: valid ? query.error : new Error("Invalid project id"), setProject };
}

/** A list belonging to the project (domains, env files, ...), with a cache setter. */
function useProjectList<T>(key: QueryKey, fetcher: () => Promise<T[]>, enabled: boolean) {
  const query = useQuery({ queryKey: key, queryFn: fetcher, enabled });
  const set = useCallback((next: Updater<T[]>) => cacheSetter<T[]>(key, [])(next), [key]);
  return [query.data ?? (EMPTY as T[]), set, query.isLoading] as const;
}

export function useProjectDomains(projectId: number, enabled: boolean) {
  return useProjectList<ProjectDomain>([...queryKeys.project(projectId), "domains"], () => api.listProjectDomains(projectId), enabled);
}

export function useProjectTcpExposures(projectId: number, enabled: boolean) {
  return useProjectList<TcpExposure>([...queryKeys.project(projectId), "tcp"], () => api.listTcpExposures(projectId), enabled);
}

export function useProjectEnvFiles(projectId: number, enabled: boolean) {
  return useProjectList<ProjectEnvFile>([...queryKeys.project(projectId), "env-files"], () => api.listProjectEnvFiles(projectId), enabled);
}

export function useProjectDeploys(projectId: number, enabled: boolean) {
  return useProjectList<ProjectDeploy>(queryKeys.projectDeploys(projectId), () => api.getProjectDeploys(projectId), enabled);
}

export function useProjectRevisions(projectId: number, enabled: boolean) {
  return useProjectList<ProjectDeploymentRevision>(queryKeys.projectRevisions(projectId), () => api.getProjectDeploymentRevisions(projectId), enabled);
}

export function useCredentials() {
  return useProjectList<Credential>(["credentials"], () => api.listCredentials(), true);
}

/** The project's build/deploy slot: the action running on it now (from the tracker),
 *  and the most recent one that finished (refetched whenever one ends). */
export function useProjectRepoAction(projectId: number, enabled: boolean): { running: ActionSummary | null; last: ActionSummary | null } {
  const runningList = useRunningActionRecords();
  const running = runningList.find((record) => record.key === `project:${projectId}:repo`) ?? null;
  const { data } = useQuery({
    queryKey: queryKeys.projectActions(projectId),
    queryFn: () => api.getProjectActions(projectId),
    enabled,
  });
  const repo = data?.repo ?? null;
  const last = repo && repo.status !== "running" ? repo : null;
  return { running, last };
}
