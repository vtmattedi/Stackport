import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { notify } from "../lib/notify";
import { actionTracker, waitForActionResult } from "./ActionTracker";
import type {
  ActionRecord,
  ActionStartResponse,
  FirewallProfile,
  GitHubPollerConfig,
  Project,
  SystemActionsSnapshot,
  SystemData,
  VpsData,
} from "../api/types";
import { useChannelData, useSocket } from "./SocketContext";

type ProjectActionKind = "pull" | "compose" | "deploy" | "stop" | "stop-purge" | "build" | "recreate" | "force-rebuild" | "rollback";
type CertbotOp = "issue" | "renew" | "delete";
interface ProjectActionOpts {
  /** "pull"/"deploy" only — checks out this branch before pulling instead of the default one. */
  branch?: string;
  /** "rollback" only — the revision to restore instead of the default previous one. */
  deploymentId?: number;
}

const PROJECT_ACTION_LABELS: Record<ProjectActionKind, string> = {
  pull: "Pull from GitHub",
  compose: "Docker Compose",
  deploy: "Deploy",
  stop: "Stop",
  "stop-purge": "Stop & Delete Data",
  build: "Build",
  recreate: "Force Recreate",
  "force-rebuild": "Force Rebuild",
  rollback: "Rollback",
};

const PROJECT_ACTION_REQUEST: Record<ProjectActionKind, (projectId: number, opts?: ProjectActionOpts) => Promise<ActionStartResponse>> = {
  pull: (projectId, opts) => api.pullProject(projectId, opts?.branch),
  compose: (projectId) => api.composeProject(projectId),
  deploy: (projectId, opts) => api.deployProject(projectId, opts?.branch),
  stop: (projectId) => api.stopProject(projectId),
  "stop-purge": (projectId) => api.stopAndPurgeProject(projectId),
  build: (projectId) => api.buildProject(projectId),
  recreate: (projectId) => api.recreateProject(projectId),
  "force-rebuild": (projectId) => api.forceRebuildProject(projectId),
  rollback: (projectId, opts) => api.rollbackProject(projectId, opts?.deploymentId),
};

/** The live, frequently-changing half of the system context. */
export interface SystemSnapshot {
  system: SystemData | null;
  projects: Project[] | null;
  vps: VpsData | null;
  github: GitHubPollerConfig | null;
  firewallProfiles: FirewallProfile[] | null;
  systemActions: SystemActionsSnapshot;
}

/** The stable half: refreshers and action wrappers. Their identities don't change
 *  when live data arrives, so components that only need these never re-render for it. */
interface SystemActionsValue {
  refreshSystem: () => void;
  refreshProjects: () => void;
  refreshVps: () => void;
  refreshGithub: () => Promise<void>;
  refreshFirewall: (providerId?: number) => Promise<void>;
  /** Start a project repo-slot action (pull/compose/deploy/stop/build), tracking a toast + GET /projects/:id/actions until it finishes — even if the caller unmounts. */
  startProjectAction: (projectId: number, kind: ProjectActionKind, opts?: ProjectActionOpts) => Promise<ActionRecord | null>;
  /** Redeploy (rebuild + restart) a single compose service, tracking a build-progress toast until it finishes. Shares the project's repo action slot. */
  redeployProjectContainer: (projectId: number, service: string) => Promise<ActionRecord | null>;
  /** Stop + remove a single compose service's container and every volume mounted into it. Destructive — caller must confirm with the user first. Shares the project's repo action slot. */
  dropProjectServiceVolumes: (projectId: number, service: string) => Promise<ActionRecord | null>;
  /** Start a project domain's ssl-issue action, tracking a toast until it finishes. */
  issueProjectDomainSsl: (projectId: number, domainId: number) => Promise<ActionRecord | null>;
  /** Start a nginx apply, tracking a toast until it finishes. */
  applyNginx: () => Promise<ActionRecord | null>;
  /** Update the STACKPORT app's published domain/port/ssl and apply nginx, tracking a toast until it finishes. */
  updateNginxAppConfig: (cfg: { enabled: boolean; domain: string; useSsl: boolean }) => Promise<ActionRecord | null>;
  /** Start a certbot issue/renew/delete for a domain, tracking a toast until it finishes. */
  certbotAction: (domain: string, action: CertbotOp) => Promise<ActionRecord | null>;
  /** Start a docker build cache prune, tracking a toast until it finishes. */
  pruneDockerCache: () => Promise<ActionRecord | null>;
}

type SystemContextValue = SystemSnapshot & SystemActionsValue;

interface SystemStore {
  get: () => SystemSnapshot;
  subscribe: (listener: () => void) => () => void;
}

const EMPTY_SYSTEM_ACTIONS: SystemActionsSnapshot = { nginx: null, certbot: [], docker: null };

const SystemContext = createContext<SystemContextValue | null>(null);
const SystemActionsContext = createContext<SystemActionsValue | null>(null);
const SystemStoreContext = createContext<SystemStore | null>(null);

/**
 * Starts an action and resolves with its final record, log included, once it ends.
 * Toasts are not shown here: GlobalActionToasts shows one for every action, whoever
 * started it. The tracker learns about the action from the start response too, so a
 * fast action that ends before its socket event arrives is still seen.
 */
async function runAction(start: () => Promise<ActionStartResponse>, label: string): Promise<ActionRecord | null> {
  let result: ActionStartResponse;
  try {
    result = await start();
  } catch (err) {
    notify.error(err, `Failed to start ${label}`);
    return null;
  }
  if (!result.started) {
    notify.error(new Error(result.error ?? `${label} is already running`), "Action already running");
    return result.action;
  }
  if (!result.action) return null;
  const { log: _log, ...summary } = result.action;
  actionTracker.started(summary);
  return waitForActionResult(result.action.id);
}

/**
 * Loads system-wide state (projects, system/docker/nginx/certbot, vps, github
 * poller config, firewall profiles, in-flight system actions) on mount and
 * keeps it current via WS. Also owns the "start an action -> toast -> wait
 * for completion" lifecycle for nginx/certbot/project actions, so toasts
 * survive page navigation.
 */
export function SystemProvider({ children }: { children: React.ReactNode }) {
  const { subscribeSystemActionsSync, unsubscribeSystemActionsSync } = useSocket();
  const { data: system, refresh: refreshSystem } = useChannelData<SystemData>("system", { fallback: () => api.getSystem() });
  const { data: projects, refresh: refreshProjects } = useChannelData<Project[]>("projects", { fallback: () => api.listProjects() });
  const { data: vps, refresh: refreshVps } = useChannelData<VpsData>("vps", { fallback: () => api.getVm() });
  const queryClient = useQueryClient();
  const { data: github = null } = useQuery({ queryKey: queryKeys.githubPoller, queryFn: () => api.getGithubPollerConfig() });
  const [firewallProfiles, setFirewallProfiles] = useState<FirewallProfile[] | null>(null);
  // The nginx, certbot and docker slots: refetched when a system action starts or ends
  // (ActionTracker invalidates them), and pushed by the server on connect.
  const { data: systemActions = EMPTY_SYSTEM_ACTIONS } = useQuery({
    queryKey: queryKeys.systemActions,
    queryFn: () => api.getSystemActions(),
  });
  // Action wrappers only need a project's name for toast labels; reading it through a
  // ref keeps their identities stable instead of changing on every projects push.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const refreshGithub = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.githubPoller });
  }, [queryClient]);

  const firstProviderId = vps?.providers[0]?.id;
  const refreshFirewall = useCallback(async (providerId?: number) => {
    const id = providerId ?? firstProviderId;
    if (id == null) {
      setFirewallProfiles(null);
      return;
    }
    try {
      setFirewallProfiles(await api.listFirewallProfiles(id));
    } catch { /* non-critical */ }
  }, [firstProviderId]);

  useEffect(() => { void refreshFirewall(firstProviderId); }, [firstProviderId, refreshFirewall]);

  useEffect(() => {
    const handler = (snap: SystemActionsSnapshot) => queryClient.setQueryData(queryKeys.systemActions, snap);
    subscribeSystemActionsSync<SystemActionsSnapshot>(handler);
    return () => unsubscribeSystemActionsSync<SystemActionsSnapshot>(handler);
  }, [queryClient, subscribeSystemActionsSync, unsubscribeSystemActionsSync]);

  // ── action wrappers ("fire events") ─────────────────────────────────────────

  const startProjectAction = useCallback(async (projectId: number, kind: ProjectActionKind, opts?: ProjectActionOpts): Promise<ActionRecord | null> => {
    const final = await runAction(() => PROJECT_ACTION_REQUEST[kind](projectId, opts), PROJECT_ACTION_LABELS[kind]);
    refreshProjects();
    return final;
  }, [refreshProjects]);

  const redeployProjectContainer = useCallback(async (projectId: number, service: string): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.redeployProjectContainer(projectId, service), `Redeploy ${service}`);
    refreshProjects();
    return final;
  }, [refreshProjects]);

  /** Destructive — the caller (the per-container UI) is expected to confirm with the
   *  user before calling this. */
  const dropProjectServiceVolumes = useCallback(async (projectId: number, service: string): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.dropProjectServiceVolumes(projectId, service), `Drop volumes for ${service}`);
    refreshProjects();
    return final;
  }, [refreshProjects]);

  const issueProjectDomainSsl = useCallback(async (projectId: number, domainId: number): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.issueProjectDomainSsl(projectId, domainId), "SSL issuance");
    refreshSystem();
    refreshProjects();
    return final;
  }, [refreshSystem, refreshProjects]);

  const applyNginx = useCallback(async (): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.applyNginx(), "Nginx apply");
    refreshSystem();
    return final;
  }, [refreshSystem]);

  const updateNginxAppConfig = useCallback(async (cfg: { enabled: boolean; domain: string; useSsl: boolean }): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.updateNginxAppConfig(cfg), "Stackport nginx publishing");
    refreshSystem();
    return final;
  }, [refreshSystem]);

  const certbotAction = useCallback(async (domain: string, action: CertbotOp): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.certbotAction(domain, action), `Certbot ${action}`);
    refreshSystem();
    return final;
  }, [refreshSystem]);

  const pruneDockerCache = useCallback(async (): Promise<ActionRecord | null> => {
    const final = await runAction(() => api.pruneDockerBuildCache(), "Docker prune");
    refreshSystem();
    return final;
  }, [refreshSystem]);

  const actions = useMemo<SystemActionsValue>(() => ({
    refreshSystem, refreshProjects, refreshVps, refreshGithub, refreshFirewall,
    startProjectAction, redeployProjectContainer, dropProjectServiceVolumes, issueProjectDomainSsl, applyNginx, updateNginxAppConfig, certbotAction, pruneDockerCache,
  }), [
    refreshSystem, refreshProjects, refreshVps, refreshGithub, refreshFirewall,
    startProjectAction, redeployProjectContainer, dropProjectServiceVolumes, issueProjectDomainSsl, applyNginx, updateNginxAppConfig, certbotAction, pruneDockerCache,
  ]);

  const snapshot = useMemo<SystemSnapshot>(
    () => ({ system, projects, vps, github, firewallProfiles, systemActions }),
    [system, projects, vps, github, firewallProfiles, systemActions],
  );

  // A tiny external store over `snapshot`, so a component can subscribe to just the
  // slice it renders (useSystemSelector) instead of re-rendering on every push.
  const snapshotRef = useRef(snapshot);
  const listenersRef = useRef(new Set<() => void>());
  const store = useMemo<SystemStore>(() => ({
    get: () => snapshotRef.current,
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => { listenersRef.current.delete(listener); };
    },
  }), []);
  useEffect(() => {
    snapshotRef.current = snapshot;
    for (const listener of listenersRef.current) listener();
  }, [snapshot]);

  const value = useMemo<SystemContextValue>(() => ({ ...snapshot, ...actions }), [snapshot, actions]);

  return (
    <SystemActionsContext.Provider value={actions}>
      <SystemStoreContext.Provider value={store}>
        <SystemContext.Provider value={value}>
          {children}
        </SystemContext.Provider>
      </SystemStoreContext.Provider>
    </SystemActionsContext.Provider>
  );
}

export function useSystem(): SystemContextValue {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used inside <SystemProvider>");
  return ctx;
}

/** Stable refreshers and action wrappers only — never re-renders for live data. */
export function useSystemActions(): SystemActionsValue {
  const ctx = useContext(SystemActionsContext);
  if (!ctx) throw new Error("useSystemActions must be used inside <SystemProvider>");
  return ctx;
}

/** Structural equality for small derived slices, via JSON. Keep selected slices small. */
export function jsonEqual<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Subscribes to one slice of the live system snapshot. The component re-renders only
 * when `isEqual` says the slice changed — e.g. the project page selects its own Docker
 * stack minus CPU/RAM stats, so the 5-second system push no longer rebuilds the page.
 */
export function useSystemSelector<T>(selector: (snapshot: SystemSnapshot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useContext(SystemStoreContext);
  if (!store) throw new Error("useSystemSelector must be used inside <SystemProvider>");
  const cacheRef = useRef<{ value: T } | null>(null);
  const getSelection = () => {
    const next = selector(store.get());
    const cached = cacheRef.current;
    if (cached && isEqual(cached.value, next)) return cached.value;
    cacheRef.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
