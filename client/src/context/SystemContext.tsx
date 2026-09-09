import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { notify } from "../lib/notify";
import { truncateLabel } from "../lib/format";
import { BuildProgressToast } from "../components/BuildProgressToast";
import type {
  ActionRecord,
  ActionStartResponse,
  FirewallProfile,
  GitHubPollerConfig,
  GlobalRealtimeEvent,
  Project,
  ProjectActionsSnapshot,
  ProjectBuildProgressEvent,
  SystemActionsSnapshot,
  SystemData,
  VpsData,
} from "../api/types";
import { useChannelData, useSocket } from "./SocketContext";

type ToastId = string | number;
type ProjectActionKind = "pull" | "compose" | "deploy" | "stop" | "stop-purge" | "build" | "recreate" | "force-rebuild" | "rollback";
type CertbotOp = "issue" | "renew" | "delete";
interface ProjectActionOpts {
  /** "pull" only — checks out this branch before pulling instead of staying on whatever's checked out. */
  branch?: string;
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

/** Kinds safe to SIGTERM mid-run (long-lived docker/git child processes) — stop/stop-purge, nginx apply, and certbot are excluded (see actionRegistry.cancel on the server). */
const CANCELABLE_PROJECT_ACTION_KINDS = new Set<string>(["pull", "compose", "deploy", "build", "recreate", "force-rebuild", "redeploy-service", "rollback"]);

/** Kinds that run a docker compose build/up and therefore get a live progress bar
 *  toast instead of the plain spinner+text one — pull alone has no build step, and
 *  stop/stop-purge only ever run `down`, neither of which the progress tracker
 *  estimates anything meaningful for. */
const BUILD_PROGRESS_KINDS = new Set<string>(["build", "compose", "deploy", "recreate", "force-rebuild", "rollback"]);

/** Attaches a toast "Cancel" button that requests server-side cancellation and flips the toast to a "Cancelling..." state while the kill takes effect. */
function cancelToastAction(projectId: number, kind: string, prefix: string, label: string, getToastId: () => ToastId): { label: string; onClick: () => void } | undefined {
  if (!CANCELABLE_PROJECT_ACTION_KINDS.has(kind)) return undefined;
  return {
    label: "Cancel",
    onClick: () => {
      notify.loading(`${prefix}Cancelling ${label}...`, { id: getToastId() });
      void api.cancelProjectAction(projectId).catch(() => {});
    },
  };
}

const PROJECT_ACTION_REQUEST: Record<ProjectActionKind, (projectId: number, opts?: ProjectActionOpts) => Promise<ActionStartResponse>> = {
  pull: (projectId, opts) => api.pullProject(projectId, opts?.branch),
  compose: (projectId) => api.composeProject(projectId),
  deploy: (projectId) => api.deployProject(projectId),
  stop: (projectId) => api.stopProject(projectId),
  "stop-purge": (projectId) => api.stopAndPurgeProject(projectId),
  build: (projectId) => api.buildProject(projectId),
  recreate: (projectId) => api.recreateProject(projectId),
  "force-rebuild": (projectId) => api.forceRebuildProject(projectId),
  rollback: (projectId) => api.rollbackProject(projectId),
};

interface SystemContextValue {
  system: SystemData | null;
  projects: Project[] | null;
  vps: VpsData | null;
  github: GitHubPollerConfig | null;
  firewallProfiles: FirewallProfile[] | null;
  systemActions: SystemActionsSnapshot;
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

const SystemContext = createContext<SystemContextValue | null>(null);

/** Poll GET /projects/:id/actions until the repo slot is no longer "running". Used
 *  for actions with no live progress estimate (pull/stop/stop-purge) — build-like
 *  actions instead await trackBuildProgressToast's WS-driven completion signal. */
export async function pollProjectAction(projectId: number, slot: "repo"): Promise<ActionRecord | null> {
  for (;;) {
    const snapshot = await api.getProjectActions(projectId);
    const record = snapshot[slot];
    if (!record || record.status !== "running") return record;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function actionFailureMessage(record: ActionRecord | null, fallback: string): string {
  return record?.log || fallback;
}

/** The subset of useSocket()'s API these WS-driven waiters need. */
interface SocketLike {
  emit: (event: string, payload?: unknown) => void;
  on: <T>(event: string, handler: (data: T) => void) => void;
  off: <T>(event: string, handler: (data: T) => void) => void;
}

/** Waits for a project's repo-slot action (pull/stop/stop-purge/drop-volumes, or any
 *  other action not tracked via trackBuildProgressToast) to finish — the WS-driven
 *  replacement for pollProjectAction's REST loop. emitProjectDeploy already pushes a
 *  project:build-progress event with done:true for every action regardless of kind
 *  (build-progress-tracked or not), and project:deploy:sync — sent synchronously in
 *  response to our own deploy:subscribe — catches the case where the action already
 *  finished before we started listening. Resolves with just the ok flag; the caller
 *  fetches GET /projects/:id/actions once afterward for the full final record. */
function awaitProjectActionDone(socket: SocketLike, projectId: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.off<ProjectBuildProgressEvent>("project:build-progress", progressHandler);
      socket.off<ProjectActionsSnapshot>("project:deploy:sync", syncHandler);
      socket.emit("deploy:unsubscribe", projectId);
      resolve(ok);
    };
    const progressHandler = (event: ProjectBuildProgressEvent) => {
      if (event.projectId === projectId && event.done) finish(event.ok ?? false);
    };
    const syncHandler = (snap: ProjectActionsSnapshot) => {
      const record = snap.repo;
      if (record && record.projectId === projectId && record.status !== "running") finish(record.ok ?? false);
    };
    // Listeners registered before the subscribe request is even sent, so nothing
    // the server sends in response can arrive before we're ready for it.
    socket.on<ProjectBuildProgressEvent>("project:build-progress", progressHandler);
    socket.on<ProjectActionsSnapshot>("project:deploy:sync", syncHandler);
    socket.emit("deploy:subscribe", projectId);
  });
}

/** Same idea as awaitProjectActionDone, but for one domain's ssl-issue slot — each
 *  project can have several running (or just-finished) in parallel, one per domain.
 *  SSL issuance is nginx+certbot, not docker compose, so it never goes through
 *  emitProjectDeploy/project:build-progress — completion instead comes from the
 *  ssl-issue route's own global nginx:flow events (filtered to this project+domain),
 *  with project:deploy:sync's `ssl` array as the catch-up path for an action that
 *  already finished before we subscribed. */
function awaitSslIssueDone(socket: SocketLike, projectId: number, domainId: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.off<ProjectActionsSnapshot>("project:deploy:sync", syncHandler);
      socket.off<GlobalRealtimeEvent>("global:event", globalHandler);
      socket.emit("deploy:unsubscribe", projectId);
      resolve(ok);
    };
    const syncHandler = (snap: ProjectActionsSnapshot) => {
      const record = snap.ssl.find((entry) => entry.meta?.["domainId"] === domainId);
      if (record && record.status !== "running") finish(record.ok ?? false);
    };
    const globalHandler = (event: GlobalRealtimeEvent) => {
      if (event.type !== "nginx:flow" || event.projectId !== projectId || event.domainId !== domainId) return;
      if (event.status === "success") finish(true);
      else if (event.status === "failed") finish(false);
    };
    socket.on<ProjectActionsSnapshot>("project:deploy:sync", syncHandler);
    socket.on<GlobalRealtimeEvent>("global:event", globalHandler);
    socket.emit("deploy:subscribe", projectId);
  });
}

/** awaitProjectActionDone + a follow-up GET /projects/:id/actions fetch for the full
 *  final record (not a poll loop — one fetch, right after the WS signal) — the "just
 *  tell me when it's done and what happened" convenience wrapper used by every plain
 *  (non-build-progress) project action. */
async function awaitProjectActionFinal(socket: SocketLike, projectId: number): Promise<ActionRecord | null> {
  await awaitProjectActionDone(socket, projectId);
  const snap = await api.getProjectActions(projectId).catch(() => null);
  return snap?.repo ?? null;
}

/** Same idea, for one domain's ssl-issue slot. */
async function awaitSslIssueFinal(socket: SocketLike, projectId: number, domainId: number): Promise<ActionRecord | null> {
  await awaitSslIssueDone(socket, projectId, domainId);
  const snap = await api.getProjectActions(projectId).catch(() => null);
  return snap?.ssl.find((entry) => entry.meta?.["domainId"] === domainId) ?? null;
}

/** Waits for the single-flight nginx-apply or docker-prune action to finish. Both are
 *  global (not per-project) single-flight slots, so there's no id/target to filter by
 *  — whichever matching-type global:event arrives after this is called is this
 *  action's. Also races a one-shot GET /system/actions check against the listener
 *  (registered first) since, unlike the deploy-room case, there's no request tied to
 *  our own subscribe that's guaranteed to reflect the current state synchronously —
 *  this is what catches an action that finished before we started waiting. */
function awaitGlobalFlowDone(socket: SocketLike, type: "nginx:flow" | "docker:flow"): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off<GlobalRealtimeEvent>("global:event", handler);
      resolve();
    };
    const handler = (event: GlobalRealtimeEvent) => {
      if (event.type === type && event.status !== "started") finish();
    };
    socket.on<GlobalRealtimeEvent>("global:event", handler);

    void api.getSystemActions().then((snap) => {
      const record = type === "nginx:flow" ? snap.nginx : snap.docker;
      if (!record || record.status !== "running") finish();
    });
  });
}

/** Creates a build-progress toast exactly once and resolves when the action finishes
 *  — the WS-driven replacement for polling. `BuildProgressToast` owns its own live
 *  updates from here on (see that component); this function is never called again
 *  for the same action, so the toast is never handed fresh props externally. On
 *  completion, fetches the final ActionRecord once (not a poll loop) for the
 *  success/fail detail the lean WS event doesn't carry. */
function trackBuildProgressToast(
  projectId: number,
  title: string,
  initialAction: ActionRecord,
  cancelAction: (getToastId: () => ToastId) => { label: string; onClick: () => void } | undefined,
): Promise<{ toastId: ToastId; final: ActionRecord | null }> {
  return new Promise((resolve) => {
    let toastId: ToastId;
    toastId = notify.loading(
      <BuildProgressToast
        projectId={projectId}
        title={title}
        initialPhase={initialAction.phase}
        initialProgress={initialAction.progress}
        startedAt={initialAction.startedAt}
        onDone={() => {
          void api.getProjectActions(projectId)
            .then((snap) => resolve({ toastId, final: snap.repo }))
            .catch(() => resolve({ toastId, final: null }));
        }}
      />,
      { action: cancelAction(() => toastId) },
    );
  });
}

/** Shared success/cancelled/failed toast resolution — used identically wherever a
 *  project repo-slot action (tracked via polling or via trackBuildProgressToast)
 *  reaches a final ActionRecord. */
function resolveActionToast(toastId: ToastId, final: ActionRecord | null, title: string, label: string): void {
  if (final?.meta?.["cancelledByUser"]) {
    notify.success(`${title} cancelled.`, { id: toastId });
  } else if (final?.ok) {
    notify.success(`${title} completed.`, { id: toastId });
  } else {
    notify.error(new Error(actionFailureMessage(final, `${label} failed`)), `${title} failed`, { id: toastId });
  }
}

function upsertCertbotRecord(list: ActionRecord[], record: ActionRecord): ActionRecord[] {
  const index = list.findIndex((entry) => entry.key === record.key);
  if (index === -1) return [...list, record];
  const next = [...list];
  next[index] = record;
  return next;
}

/**
 * Loads system-wide state (projects, system/docker/nginx/certbot, vps, github
 * poller config, firewall profiles, in-flight system actions) on mount and
 * keeps it current via WS. Also owns the "start an action -> toast -> wait
 * for completion" lifecycle for nginx/certbot/project actions, so toasts
 * survive page navigation.
 */
export function SystemProvider({ children }: { children: React.ReactNode }) {
  const { subscribeSystemActionsSync, unsubscribeSystemActionsSync, emit, on, off } = useSocket();
  // emit/on/off are themselves stable across renders (useCallback with empty deps in
  // SocketContext) — bundled via useMemo so this object is too, otherwise every
  // useCallback below that depends on it would see a "new" value every render.
  const socket = useMemo<SocketLike>(() => ({ emit, on, off }), [emit, on, off]);
  const { data: system, refresh: refreshSystem } = useChannelData<SystemData>("system", { fallback: () => api.getSystem() });
  const { data: projects, refresh: refreshProjects } = useChannelData<Project[]>("projects", { fallback: () => api.listProjects() });
  const { data: vps, refresh: refreshVps } = useChannelData<VpsData>("vps", { fallback: () => api.getVm() });
  const [github, setGithub] = useState<GitHubPollerConfig | null>(null);
  const [firewallProfiles, setFirewallProfiles] = useState<FirewallProfile[] | null>(null);
  const [systemActions, setSystemActions] = useState<SystemActionsSnapshot>({ nginx: null, certbot: [], docker: null });
  const resumedRef = useRef(false);
  const resumedProjectActionsRef = useRef(false);

  const refreshGithub = useCallback(async () => {
    try {
      setGithub(await api.getGithubPollerConfig());
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { void refreshGithub(); }, [refreshGithub]);

  const refreshFirewall = useCallback(async (providerId?: number) => {
    const id = providerId ?? vps?.providers[0]?.id;
    if (id == null) {
      setFirewallProfiles(null);
      return;
    }
    try {
      setFirewallProfiles(await api.listFirewallProfiles(id));
    } catch { /* non-critical */ }
  }, [vps]);

  const firstProviderId = vps?.providers[0]?.id;
  useEffect(() => { void refreshFirewall(firstProviderId); }, [firstProviderId, refreshFirewall]);

  // ── nginx / docker / certbot completion waiters ───────────────────────────
  // nginx apply and docker prune are WS-driven (see awaitGlobalFlowDone) — certbot
  // stays on REST polling for now (its own live event only covers the post-action
  // nginx-reapply step, not the certbot CLI call itself).

  const awaitNginxApplyDone = useCallback(async (): Promise<ActionRecord | null> => {
    await awaitGlobalFlowDone(socket, "nginx:flow");
    const snap = await api.getSystemActions();
    setSystemActions(snap);
    return snap.nginx;
  }, [socket]);

  const awaitDockerPruneDone = useCallback(async (): Promise<ActionRecord | null> => {
    await awaitGlobalFlowDone(socket, "docker:flow");
    const snap = await api.getSystemActions();
    setSystemActions(snap);
    return snap.docker;
  }, [socket]);

  const pollCertbotAction = useCallback(async (domain: string, action: CertbotOp): Promise<ActionRecord | null> => {
    for (;;) {
      const snap = await api.getSystemActions();
      setSystemActions(snap);
      const record = snap.certbot.find((entry) => entry.meta?.["domain"] === domain && entry.meta?.["action"] === action);
      if (!record || record.status !== "running") return record ?? null;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }, []);

  // Seed systemActions and resume any in-flight nginx/certbot toast on mount.
  useEffect(() => {
    let cancelled = false;
    void api.getSystemActions().then((snap) => {
      if (cancelled) return;
      setSystemActions(snap);
      if (resumedRef.current) return;
      resumedRef.current = true;

      if (snap.nginx?.status === "running") {
        const toastId = notify.loading("Applying nginx config...");
        void awaitNginxApplyDone().then((final) => {
          if (final?.ok) notify.success("Nginx config applied.", { id: toastId });
          else notify.error(new Error(actionFailureMessage(final, "Nginx apply failed")), "Nginx apply failed", { id: toastId });
          refreshSystem();
        });
      }

      for (const record of snap.certbot) {
        if (record.status !== "running") continue;
        const domain = record.meta?.["domain"] as string | undefined;
        const action = record.meta?.["action"] as CertbotOp | undefined;
        if (!domain || !action) continue;
        const toastId = notify.loading(`${domain}: certbot ${action}...`);
        void pollCertbotAction(domain, action).then((final) => {
          if (final?.ok) notify.success(`${domain}: ${action} completed.`, { id: toastId });
          else notify.error(new Error(actionFailureMessage(final, `${action} failed`)), `${domain}: ${action} failed`, { id: toastId });
          refreshSystem();
        });
      }

      if (snap.docker?.status === "running") {
        const toastId = notify.loading("Pruning docker build cache...");
        void awaitDockerPruneDone().then((final) => {
          if (final?.ok) notify.success("Docker build cache pruned.", { id: toastId });
          else notify.error(new Error(actionFailureMessage(final, "Docker prune failed")), "Docker prune failed", { id: toastId });
          refreshSystem();
        });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (snap: SystemActionsSnapshot) => setSystemActions(snap);
    subscribeSystemActionsSync<SystemActionsSnapshot>(handler);
    return () => unsubscribeSystemActionsSync<SystemActionsSnapshot>(handler);
  }, [subscribeSystemActionsSync, unsubscribeSystemActionsSync]);

  // Resume a toast for every project build/deploy/pull/... or ssl-issue action still
  // running server-side on mount — e.g. one kicked off from another tab, or still
  // in flight across a page reload.
  useEffect(() => {
    if (resumedProjectActionsRef.current) return;
    resumedProjectActionsRef.current = true;

    void api.getRunningProjectActions().then((running) => {
      for (const { action, projectId, projectName } of running) {
        if (projectId == null) continue;
        const isSsl = action.key.includes(":ssl:");
        const domainId = isSsl ? (action.meta?.["domainId"] as number | undefined) : undefined;
        if (isSsl && domainId == null) continue;
        const label = isSsl ? "SSL issuance" : (PROJECT_ACTION_LABELS[action.kind as ProjectActionKind] ?? action.kind);
        const prefix = projectName ? `${truncateLabel(projectName)}: ` : "";
        const trackProgress = !isSsl && BUILD_PROGRESS_KINDS.has(action.kind);
        const title = `${prefix}${label}`;

        if (trackProgress) {
          void trackBuildProgressToast(projectId, title, action, (getToastId) => cancelToastAction(projectId, action.kind, prefix, label, getToastId))
            .then(({ toastId, final }) => {
              resolveActionToast(toastId, final, title, label);
              refreshProjects();
            });
          continue;
        }

        let toastId: ToastId = notify.loading(`${title}...`, {
          action: !isSsl ? cancelToastAction(projectId, action.kind, prefix, label, () => toastId) : undefined,
        });

        const final = isSsl
          ? awaitSslIssueFinal(socket, projectId, domainId as number)
          : awaitProjectActionFinal(socket, projectId);
        void final.then((result) => {
          resolveActionToast(toastId, result, title, label);
          refreshProjects();
          if (isSsl) refreshSystem();
        });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── action wrappers ("fire events") ─────────────────────────────────────────

  const startProjectAction = useCallback(async (projectId: number, kind: ProjectActionKind, opts?: ProjectActionOpts): Promise<ActionRecord | null> => {
    const label = PROJECT_ACTION_LABELS[kind];
    const projectName = projects?.find((p) => p.id === projectId)?.name;
    const prefix = projectName ? `${truncateLabel(projectName)}: ` : "";
    let result: ActionStartResponse;
    try {
      result = await PROJECT_ACTION_REQUEST[kind](projectId, opts);
    } catch (err) {
      notify.error(err, `Failed to start ${label}`);
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? `${label} is already running for this project`), "Action already running");
      return result.action;
    }
    const title = `${prefix}${label}`;
    const cancelAction = (getToastId: () => ToastId) => cancelToastAction(projectId, kind, prefix, label, getToastId);

    let toastId: ToastId;
    let final: ActionRecord | null;
    if (BUILD_PROGRESS_KINDS.has(kind) && result.action) {
      ({ toastId, final } = await trackBuildProgressToast(projectId, title, result.action, cancelAction));
    } else {
      toastId = notify.loading(`${title} started...`, { action: cancelAction(() => toastId) });
      final = await awaitProjectActionFinal(socket, projectId);
    }
    resolveActionToast(toastId, final, title, label);
    refreshProjects();
    return final;
  }, [refreshProjects, projects, socket]);

  const redeployProjectContainer = useCallback(async (projectId: number, service: string): Promise<ActionRecord | null> => {
    const projectName = projects?.find((p) => p.id === projectId)?.name;
    const prefix = projectName ? `${truncateLabel(projectName)}: ` : "";
    const label = `Redeploy ${service}`;
    let result: ActionStartResponse;
    try {
      result = await api.redeployProjectContainer(projectId, service);
    } catch (err) {
      notify.error(err, `Failed to start ${label}`);
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? `${label} is already running for this project`), "Action already running");
      return result.action;
    }
    const title = `${prefix}${label}`;
    const cancelAction = (getToastId: () => ToastId) => cancelToastAction(projectId, "redeploy-service", prefix, label, getToastId);

    let toastId: ToastId;
    let final: ActionRecord | null;
    if (result.action) {
      ({ toastId, final } = await trackBuildProgressToast(projectId, title, result.action, cancelAction));
    } else {
      toastId = notify.loading(`${title} started...`, { action: cancelAction(() => toastId) });
      final = await awaitProjectActionFinal(socket, projectId);
    }
    resolveActionToast(toastId, final, title, label);
    refreshProjects();
    return final;
  }, [refreshProjects, projects, socket]);

  /** Destructive — the caller (the per-container UI) is expected to confirm with the
   *  user before calling this. No progress bar (there's nothing BuildKit-shaped to
   *  parse — it's a container removal + a handful of volume removals) and no cancel
   *  button (drop-volumes isn't in CANCELABLE_PROJECT_ACTION_KINDS — matches
   *  stop/stop-purge: fast, destructive, not something to interrupt mid-flight). */
  const dropProjectServiceVolumes = useCallback(async (projectId: number, service: string): Promise<ActionRecord | null> => {
    const projectName = projects?.find((p) => p.id === projectId)?.name;
    const prefix = projectName ? `${truncateLabel(projectName)}: ` : "";
    const label = `Drop volumes for ${service}`;
    let result: ActionStartResponse;
    try {
      result = await api.dropProjectServiceVolumes(projectId, service);
    } catch (err) {
      notify.error(err, `Failed to start ${label}`);
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? `${label} is already running for this project`), "Action already running");
      return result.action;
    }
    const title = `${prefix}${label}`;
    const toastId = notify.loading(`${title}...`);
    const final = await awaitProjectActionFinal(socket, projectId);
    resolveActionToast(toastId, final, title, label);
    refreshProjects();
    return final;
  }, [refreshProjects, projects, socket]);

  const issueProjectDomainSsl = useCallback(async (projectId: number, domainId: number): Promise<ActionRecord | null> => {
    const projectName = projects?.find((p) => p.id === projectId)?.name;
    const prefix = projectName ? `${truncateLabel(projectName)}: ` : "";
    let result: ActionStartResponse;
    try {
      result = await api.issueProjectDomainSsl(projectId, domainId);
    } catch (err) {
      notify.error(err, "Failed to start SSL issuance");
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? "An SSL action is already running for this domain"), "Action already running");
      return result.action;
    }
    const toastId = notify.loading(`${prefix}Issuing SSL certificate...`);
    const final = await awaitSslIssueFinal(socket, projectId, domainId);
    if (final?.ok) {
      notify.success(`${prefix}SSL certificate issued.`, { id: toastId });
    } else {
      notify.error(new Error(actionFailureMessage(final, "SSL issuance failed")), `${prefix}SSL issuance failed`, { id: toastId });
    }
    refreshSystem();
    refreshProjects();
    return final;
  }, [refreshSystem, refreshProjects, projects, socket]);

  const applyNginx = useCallback(async (): Promise<ActionRecord | null> => {
    let result: ActionStartResponse;
    try {
      result = await api.applyNginx();
    } catch (err) {
      notify.error(err, "Failed to start nginx apply");
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? "An nginx action is already running"), "Nginx apply already running");
      return result.action;
    }
    const startedAction = result.action;
    if (startedAction) setSystemActions((prev) => ({ ...prev, nginx: startedAction }));
    const toastId = notify.loading("Applying nginx config...");
    const final = await awaitNginxApplyDone();
    if (final?.ok) {
      notify.success("Nginx config applied.", { id: toastId });
    } else {
      notify.error(new Error(actionFailureMessage(final, "Nginx apply failed")), "Nginx apply failed", { id: toastId });
    }
    refreshSystem();
    return final;
  }, [refreshSystem, awaitNginxApplyDone]);

  const updateNginxAppConfig = useCallback(async (cfg: { enabled: boolean; domain: string; useSsl: boolean }): Promise<ActionRecord | null> => {
    let result: ActionStartResponse;
    try {
      result = await api.updateNginxAppConfig(cfg);
    } catch (err) {
      notify.error(err, "Failed to save STACKPORT Nginx publishing");
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? "An nginx action is already running"), "Nginx apply already running");
      return result.action;
    }
    const startedAction = result.action;
    if (startedAction) setSystemActions((prev) => ({ ...prev, nginx: startedAction }));
    const toastId = notify.loading("Saving STACKPORT Nginx publishing...");
    const final = await awaitNginxApplyDone();
    if (final?.ok) {
      notify.success("STACKPORT Nginx publishing saved.", { id: toastId });
    } else {
      notify.error(new Error(actionFailureMessage(final, "Nginx apply failed")), "App publishing saved but Nginx apply failed", { id: toastId });
    }
    refreshSystem();
    return final;
  }, [refreshSystem, awaitNginxApplyDone]);

  const certbotAction = useCallback(async (domain: string, action: CertbotOp): Promise<ActionRecord | null> => {
    let result: ActionStartResponse;
    try {
      result = await api.certbotAction(domain, action);
    } catch (err) {
      notify.error(err, "Certbot action failed to start");
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? `A certbot action is already running for ${domain}`), "Certbot action already running");
      return result.action;
    }
    const startedAction = result.action;
    if (startedAction) setSystemActions((prev) => ({ ...prev, certbot: upsertCertbotRecord(prev.certbot, startedAction) }));
    const toastId = notify.loading(`${domain}: certbot ${action}...`);
    const final = await pollCertbotAction(domain, action);
    if (final?.ok) {
      notify.success(`${domain}: ${action} completed.`, { id: toastId });
    } else {
      notify.error(new Error(actionFailureMessage(final, `${action} failed`)), `${domain}: ${action} failed`, { id: toastId });
    }
    refreshSystem();
    return final;
  }, [refreshSystem, pollCertbotAction]);

  const pruneDockerCache = useCallback(async (): Promise<ActionRecord | null> => {
    let result: ActionStartResponse;
    try {
      result = await api.pruneDockerBuildCache();
    } catch (err) {
      notify.error(err, "Failed to start docker prune");
      return null;
    }
    if (!result.started) {
      notify.error(new Error(result.error ?? "A docker prune is already running"), "Docker prune already running");
      return result.action;
    }
    const startedAction = result.action;
    if (startedAction) setSystemActions((prev) => ({ ...prev, docker: startedAction }));
    const toastId = notify.loading("Pruning docker build cache...");
    const final = await awaitDockerPruneDone();
    if (final?.ok) {
      notify.success("Docker build cache pruned.", { id: toastId });
    } else {
      notify.error(new Error(actionFailureMessage(final, "Docker prune failed")), "Docker prune failed", { id: toastId });
    }
    refreshSystem();
    return final;
  }, [refreshSystem, awaitDockerPruneDone]);

  return (
    <SystemContext.Provider
      value={{
        system, projects, vps, github, firewallProfiles, systemActions,
        refreshSystem, refreshProjects, refreshVps, refreshGithub, refreshFirewall,
        startProjectAction, redeployProjectContainer, dropProjectServiceVolumes, issueProjectDomainSsl, applyNginx, updateNginxAppConfig, certbotAction, pruneDockerCache,
      }}
    >
      {children}
    </SystemContext.Provider>
  );
}

export function useSystem(): SystemContextValue {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used inside <SystemProvider>");
  return ctx;
}
