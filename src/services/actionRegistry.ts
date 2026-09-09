import { randomUUID } from "crypto";
import type { Response } from "express";
import type { BuildPhase } from "./buildProgressTracker";

export type ActionStatus = "running" | "success" | "failed";

export interface ActionRecord {
  id: string;
  key: string;
  kind: string;
  projectId?: number;
  meta?: Record<string, unknown>;
  status: ActionStatus;
  ok: boolean | null;
  startedAt: string;
  completedAt: string | null;
  log: string;
  /** Best-effort build-progress estimate (see buildProgressTracker.ts) — only
   *  populated for actions that run docker compose; null for everything else
   *  (nginx apply, certbot, docker prune, a bare git pull with no build step). */
  phase: BuildPhase | null;
  progress: number | null;
}

export interface ActionRunResult {
  ok: boolean;
  output?: string;
  meta?: Record<string, unknown>;
}

const MAX_LOG_LENGTH = 256 * 1024;

function trimLog(log: string): string {
  if (log.length <= MAX_LOG_LENGTH) return log;
  return log.slice(log.length - MAX_LOG_LENGTH);
}

class ActionRegistry {
  private actions = new Map<string, ActionRecord>();
  private cancelers = new Map<string, () => void>();

  tryStart(
    key: string,
    kind: string,
    meta: Record<string, unknown> | undefined,
    runner: () => Promise<ActionRunResult>
  ): ActionRecord | null {
    const existing = this.actions.get(key);
    if (existing && existing.status === "running") return null;

    const record: ActionRecord = {
      id: randomUUID(),
      key,
      kind,
      projectId: typeof meta?.["projectId"] === "number" ? (meta["projectId"] as number) : undefined,
      meta,
      status: "running",
      ok: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      log: "",
      phase: null,
      progress: null,
    };
    this.actions.set(key, record);

    runner()
      .then((result) => this.finish(key, result.ok, result.output, result.meta))
      .catch((err) => this.finish(key, false, err instanceof Error ? err.message : String(err)));

    return record;
  }

  get(key: string): ActionRecord | undefined {
    return this.actions.get(key);
  }

  list(prefix: string): ActionRecord[] {
    return Array.from(this.actions.values()).filter((action) => action.key.startsWith(prefix));
  }

  append(key: string, message: string): void {
    const record = this.actions.get(key);
    if (!record || record.status !== "running") return;
    record.log = trimLog(record.log + message);
  }

  /** Updates the lightweight build-progress estimate independently of the log —
   *  callers (e.g. buildProgressTracker) only need to touch this, not append. */
  updateProgress(key: string, phase: BuildPhase, progress: number): void {
    const record = this.actions.get(key);
    if (!record || record.status !== "running") return;
    record.phase = phase;
    record.progress = progress;
  }

  finish(key: string, ok: boolean, output?: string, meta?: Record<string, unknown>): void {
    const record = this.actions.get(key);
    if (!record || record.status !== "running") return;
    record.status = ok ? "success" : "failed";
    record.ok = ok;
    record.completedAt = new Date().toISOString();
    if (output !== undefined) record.log = trimLog(output);
    if (meta) record.meta = { ...record.meta, ...meta };
    this.cancelers.delete(key);
  }

  /** Registers the kill-switch for the process currently backing a running action. Overwritten as a multi-step action (e.g. pull's git fetch → checkout) moves from one child process to the next. */
  registerCanceler(key: string, cancel: () => void): void {
    this.cancelers.set(key, cancel);
  }

  /** Best-effort cancel: signals the active child process and tags the record so the caller can distinguish "cancelled" from "failed" once it finishes. Returns false if nothing running/cancelable was found. */
  cancel(key: string): boolean {
    const record = this.actions.get(key);
    const canceler = this.cancelers.get(key);
    if (!record || record.status !== "running" || !canceler) return false;
    record.meta = { ...record.meta, cancelledByUser: true };
    canceler();
    return true;
  }
}

export const actionRegistry = new ActionRegistry();

export function projectRepoKey(projectId: number): string {
  return `project:${projectId}:repo`;
}

export function projectSslKey(projectId: number, domainId: number): string {
  return `project:${projectId}:ssl:${domainId}`;
}

/** Prefix matching every domain's ssl-issue slot for a project — used to list them all. */
export function projectSslKeyPrefix(projectId: number): string {
  return `project:${projectId}:ssl:`;
}

export function nginxKey(): string {
  return "system:nginx";
}

export function dockerPruneKey(): string {
  return "system:docker:prune";
}

export function certbotKey(domain: string, action: string): string {
  return `system:certbot:${domain}:${action}`;
}

export function respondActionStarted(res: Response, action: ActionRecord): void {
  res.status(200).json({ ok: true, started: true, action });
}

export function respondActionBusy(res: Response, key: string, message = "An action is already running"): void {
  res.status(409).json({
    ok: false,
    started: false,
    error: message,
    action: actionRegistry.get(key) ?? null,
  });
}
