import { Server as SocketIOServer } from "socket.io";
import type { Project } from "../entities/Project";
import { actionRegistry, projectRepoKey } from "./actionRegistry";
import { buildProgressTracker, type BuildPhase } from "./buildProgressTracker";

let io: SocketIOServer | null = null;

export interface ProjectDeployEvent {
  projectId: number;
  action: "build" | "deploy" | "stop" | "stop-purge" | "pull" | "compose" | "upload" | "recreate" | "force-rebuild" | "redeploy-service" | "drop-volumes";
  stream: "stdout" | "stderr" | "status";
  message: string;
  ok?: boolean;
  done?: boolean;
}

/** Lean, push-only companion to ProjectDeployEvent — emitted only when the build
 *  progress estimate actually changes (not on every raw output chunk), so a global
 *  "is this build progressing" UI can subscribe without processing the full verbose
 *  log stream. No `log`/`message` field on purpose; on `done`, the caller is expected
 *  to fetch the final ActionRecord once (GET /projects/:id/actions) for the full
 *  success/fail detail rather than have it duplicated over the socket. */
export interface ProjectBuildProgressEvent {
  projectId: number;
  phase: BuildPhase;
  progress: number;
  done?: boolean;
  ok?: boolean;
}

export interface GlobalRealtimeEvent {
  id: string;
  type: "nginx:flow" | "system:update" | "docker:flow";
  status: "started" | "running" | "success" | "failed";
  title: string;
  message: string;
  projectId?: number;
  projectName?: string;
  /** SSL-issue flow only — lets a client narrow down to "this project's this domain"
   *  when a project can have several domains issuing SSL concurrently (each its own
   *  actionRegistry slot), since projectId alone can't disambiguate between them. */
  domainId?: number;
  updateMode?: "full" | "frontend";
  output?: string;
  stream?: "stdout" | "stderr" | "status";
  /** Latest "[bootstrap:step] ..." milestone line seen in the self-build script's output (pulling, backup, installing deps, building, restarting, ...) — lets clients show a clean step instead of raw log spam. */
  step?: string;
  done?: boolean;
  createdAt: string;
}

export function setRealtimeServer(server: SocketIOServer): void {
  io = server;
}

function emitProjectBuildProgress(event: ProjectBuildProgressEvent): void {
  io?.to(`deploy:${event.projectId}`).emit("project:build-progress", event);
}

export function emitProjectDeploy(event: ProjectDeployEvent): void {
  io?.to(`deploy:${event.projectId}`).emit("project:deploy", event);
  const key = projectRepoKey(event.projectId);
  actionRegistry.append(key, event.message);

  // Best-effort progress estimate, parsed alongside the raw stream above — never
  // replaces it, never changes what's streamed to the client. See
  // buildProgressTracker.ts for the parsing rules. Pushed over the socket only when
  // it actually changes — not on every raw output chunk — so a listener only
  // interested in progress (not the full log) gets one lean update per real change.
  const update = buildProgressTracker.consume(key, event.message);
  if (update) {
    actionRegistry.updateProgress(key, update.phase, update.progress);
    emitProjectBuildProgress({ projectId: event.projectId, phase: update.phase, progress: update.progress });
  }

  if (event.done) {
    // Only a confirmed successful exit ever claims 100% — a failure keeps
    // whatever estimate was last reached.
    const final = buildProgressTracker.finish(key, event.ok ?? false);
    actionRegistry.updateProgress(key, final.phase, final.progress);
    actionRegistry.finish(key, event.ok ?? false);
    emitProjectBuildProgress({ projectId: event.projectId, phase: final.phase, progress: final.progress, done: true, ok: event.ok ?? false });
    buildProgressTracker.reset(key);
  }
}

/** One raw usage sample for a project's compose stack, pushed the instant
 *  projectResourceSampler.ts writes it — replaces the client's old independent
 *  15s poll of GET /:id/resources, which was desynced from the sampler's own
 *  15s timer by up to a full interval. History (bucketed) is still fetched via
 *  REST; only the always-changing "latest" gauge values are pushed live. */
export interface ProjectResourceSampleEvent {
  projectId: number;
  sample: {
    cpuPercent: number;
    memUsedMb: number;
    memLimitMb: number;
    memPercent: number;
    netRxMb: number;
    netTxMb: number;
    sampledAt: string;
  };
}

export function emitProjectResourceSample(event: ProjectResourceSampleEvent): void {
  io?.to(`project:${event.projectId}`).emit("project:resource-sample", event);
}

export function emitProjectDataUpdate(projectId: number, project: Project): void {
  io?.to(`project:${projectId}`).emit("project:update", {
    projectId,
    project,
    ports: [],
    ok: true,
    output: "",
  });
}

export function emitGlobalEvent(event: GlobalRealtimeEvent): void {
  io?.to("global").emit("global:event", event);
}

export function disconnectUserSockets(username: string, reason = "auth-revoked"): void {
  if (!io) return;

  for (const socket of io.sockets.sockets.values()) {
    if (socket.data["user"] !== username) continue;
    socket.emit("auth:revoked", { reason });
    socket.disconnect(true);
  }
}
