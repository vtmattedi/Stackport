import { randomUUID } from "crypto";
import type fs from "fs";
import { getDatabase } from "../config/database";
import { logger } from "../utils/logger";
import { actionLogPath, buildMasker, collectSecrets, openActionLog, pruneActionLogs, readActionLog, type Masker } from "./actionLog";
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

/** Action kinds that run a project's stack (`docker compose up`): what Insights and
 *  "Recent deploys" count as deploys. */
export const DEPLOY_ACTION_KINDS = ["deploy", "rollback", "recreate", "force-rebuild", "compose", "upload"] as const;

/** For inlining into SQL: the kinds are fixed literals, not input. */
export const DEPLOY_KINDS_SQL = DEPLOY_ACTION_KINDS.map((k) => `'${k}'`).join(", ");

export interface OutputChunk {
  seq: number;
  data: string;
}

/** What a client attaching to an action gets: the chunks from `fromSeq` on, or, when
 *  those are no longer in memory, the whole log as `reset` text. */
export interface ActionOutputReplay {
  id: string;
  chunks: OutputChunk[];
  reset?: string;
  nextSeq: number;
  done: boolean;
}

interface OutputState {
  /** Sequence number of the next chunk. */
  seq: number;
  chunks: OutputChunk[];
  chunkBytes: number;
  /** Raw output not yet masked and emitted: held back until a full line, briefly. */
  pending: string;
  pendingSince: number;
  timer: NodeJS.Timeout | null;
  masker: Masker;
  stream: fs.WriteStream | null;
}

const FLUSH_INTERVAL_MS = 100;
/** A partial line is held back at most this long, so a prompt without a newline still shows. */
const PARTIAL_LINE_HOLD_MS = 1_000;
const MAX_MEMORY_CHUNK_BYTES = 256 * 1024;

/** Fields annotate() may fill in on a running action, persisted with its row. */
export interface ActionAnnotation {
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  branch?: string | null;
}

function persist(run: () => void): void {
  try {
    run();
  } catch (err) {
    // Tracking must never break the action itself.
    logger.error({ err }, "action-registry.persist-failed");
  }
}

class ActionRegistry {
  private actions = new Map<string, ActionRecord>();
  private outputs = new Map<string, OutputState>();
  private cancelers = new Map<string, () => void>();
  private finishListeners = new Set<(record: ActionRecord) => void>();
  private startListeners = new Set<(record: ActionRecord) => void>();
  private outputListeners = new Set<(record: ActionRecord, chunk: OutputChunk) => void>();

  /** Called right after an action starts. Returns an unsubscribe function. */
  onStart(listener: (record: ActionRecord) => void): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }

  /** Called after any action finishes (success or failure). Returns an unsubscribe function. */
  onFinish(listener: (record: ActionRecord) => void): () => void {
    this.finishListeners.add(listener);
    return () => this.finishListeners.delete(listener);
  }

  /** Called for each masked, numbered output chunk. Returns an unsubscribe function. */
  onOutput(listener: (record: ActionRecord, chunk: OutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

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
    // The previous run on this key is replaced, along with its in-memory output; its
    // log file stays for replay until retention removes it.
    if (existing) this.outputs.delete(existing.id);
    this.actions.set(key, record);
    this.startOutput(record);
    persist(() => {
      const m = (meta ?? {}) as Partial<Record<"triggeredBy" | "commitSha" | "commitMessage" | "commitAuthor" | "branch", unknown>>;
      const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
      getDatabase().prepare(`
        INSERT INTO actions (id, key, kind, project_id, status, triggered_by, commit_sha, commit_message, commit_author, branch, started_at, log_path)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, key, kind, record.projectId ?? null, str(m.triggeredBy) ?? "manual",
        str(m.commitSha), str(m.commitMessage), str(m.commitAuthor), str(m.branch),
        record.startedAt, actionLogPath(record.id),
      );
    });
    for (const listener of this.startListeners) {
      try { listener(record); } catch { /* a listener must not break starting */ }
    }

    runner()
      .then((result) => this.finish(key, result.ok, result.output, result.meta))
      .catch((err) => this.finish(key, false, err instanceof Error ? err.message : String(err)));

    return record;
  }

  get(key: string): ActionRecord | undefined {
    return this.actions.get(key);
  }

  /** The current or most recent action with this id, while it is still the latest on its key. */
  getById(id: string): ActionRecord | undefined {
    for (const record of this.actions.values()) if (record.id === id) return record;
    return undefined;
  }

  list(prefix: string): ActionRecord[] {
    return Array.from(this.actions.values()).filter((action) => action.key.startsWith(prefix));
  }

  /** Every action running right now. */
  running(): ActionRecord[] {
    return Array.from(this.actions.values()).filter((action) => action.status === "running");
  }

  /** Queues raw output for the running action on `key`. It is masked, numbered and
   *  emitted in batches (see flush), not immediately. */
  append(key: string, message: string): void {
    const record = this.actions.get(key);
    if (!record || record.status !== "running" || !message) return;
    const state = this.outputs.get(record.id);
    if (!state) return;
    if (!state.pending) state.pendingSince = Date.now();
    state.pending += message;
    if (!state.timer) state.timer = setTimeout(() => this.flush(record, false), FLUSH_INTERVAL_MS);
  }

  /** Masks `text` with the secrets of the action running on `key`, for output that
   *  is sent to clients outside this registry (the legacy project:deploy stream). */
  mask(key: string, text: string): string {
    const record = this.actions.get(key);
    const state = record ? this.outputs.get(record.id) : undefined;
    return state ? state.masker.mask(text) : text;
  }

  /** Fills in commit details learned while the action runs (e.g. the SHA a manual
   *  deploy checked out). Fields already set are kept. */
  annotate(key: string, fields: ActionAnnotation): void {
    const record = this.actions.get(key);
    if (!record || record.status !== "running") return;
    const current = (record.meta ?? {}) as ActionAnnotation;
    record.meta = {
      ...record.meta,
      commitSha: current.commitSha ?? fields.commitSha ?? null,
      commitMessage: current.commitMessage ?? fields.commitMessage ?? null,
      commitAuthor: current.commitAuthor ?? fields.commitAuthor ?? null,
      branch: current.branch ?? fields.branch ?? null,
    };
    persist(() => {
      getDatabase().prepare(`
        UPDATE actions SET
          commit_sha = COALESCE(commit_sha, ?), commit_message = COALESCE(commit_message, ?),
          commit_author = COALESCE(commit_author, ?), branch = COALESCE(branch, ?)
        WHERE id = ?
      `).run(fields.commitSha ?? null, fields.commitMessage ?? null, fields.commitAuthor ?? null, fields.branch ?? null, record.id);
    });
  }

  /** Output of action `id` from `fromSeq` on, for a client attaching or reconnecting. */
  replay(id: string, fromSeq: number): ActionOutputReplay | null {
    const record = this.getById(id);
    const state = this.outputs.get(id);
    const done = record ? record.status !== "running" : true;
    if (state) {
      const firstSeq = state.chunks.length > 0 ? state.chunks[0].seq : state.seq;
      if (fromSeq >= firstSeq) {
        return { id, chunks: state.chunks.filter((c) => c.seq >= fromSeq), nextSeq: state.seq, done };
      }
    }
    const text = readActionLog(id);
    if (text === null && !record) return null;
    return { id, chunks: [], reset: text ?? "", nextSeq: state?.seq ?? 0, done };
  }

  /** Updates the lightweight build-progress estimate independently of the log —
   *  doesn't touch `log`, and is a no-op once the action is no longer running. */
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
    if (meta) record.meta = { ...record.meta, ...meta };
    this.cancelers.delete(key);

    const state = this.outputs.get(record.id);
    if (state) {
      // Actions that stream (project builds) already logged everything; the rest
      // (nginx, certbot, SSL, prune) only have their final output.
      if (state.seq === 0 && !state.pending && output) state.pending = output;
      this.flush(record, true);
      state.stream?.end();
      state.stream = null;
    } else if (output !== undefined) {
      record.log = trimLog(output);
    }

    const status = ok ? "success" : record.meta?.["cancelledByUser"] ? "cancelled" : "failed";
    persist(() => {
      getDatabase().prepare("UPDATE actions SET status = ?, finished_at = ? WHERE id = ?").run(status, record.completedAt, record.id);
      pruneActionLogs();
    });
    for (const listener of this.finishListeners) {
      try { listener(record); } catch { /* a listener must not break finishing */ }
    }
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

  private startOutput(record: ActionRecord): void {
    let masker = buildMasker([]);
    try {
      masker = buildMasker(collectSecrets(record.projectId));
    } catch (err) {
      logger.error({ err }, "action-registry.mask-secrets-failed");
    }
    let stream: fs.WriteStream | null = null;
    try {
      stream = openActionLog(record.id);
      stream.on("error", (err) => logger.error({ err, action: record.id }, "action-registry.log-write-failed"));
    } catch (err) {
      logger.error({ err }, "action-registry.log-open-failed");
    }
    this.outputs.set(record.id, {
      seq: 0, chunks: [], chunkBytes: 0, pending: "", pendingSince: 0, timer: null, masker, stream,
    });
  }

  /** Masks and emits pending output as one chunk. Until `final`, a trailing partial line
   *  is held back (briefly), so a secret split across two writes is still masked. */
  private flush(record: ActionRecord, final: boolean): void {
    const state = this.outputs.get(record.id);
    if (!state) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (!state.pending) return;

    let text = state.pending;
    let rest = "";
    if (!final) {
      const newline = text.lastIndexOf("\n");
      const held = Date.now() - state.pendingSince;
      if (newline === -1) {
        if (held < PARTIAL_LINE_HOLD_MS) {
          state.timer = setTimeout(() => this.flush(record, false), FLUSH_INTERVAL_MS);
          return;
        }
      } else {
        rest = text.slice(newline + 1);
        text = text.slice(0, newline + 1);
      }
    }
    state.pending = rest;
    if (rest) {
      state.pendingSince = Date.now();
      state.timer = setTimeout(() => this.flush(record, false), FLUSH_INTERVAL_MS);
    }

    const chunk: OutputChunk = { seq: state.seq++, data: state.masker.mask(text) };
    state.chunks.push(chunk);
    state.chunkBytes += chunk.data.length;
    while (state.chunkBytes > MAX_MEMORY_CHUNK_BYTES && state.chunks.length > 1) {
      state.chunkBytes -= state.chunks.shift()!.data.length;
    }
    record.log = trimLog(record.log + chunk.data);
    state.stream?.write(chunk.data);
    for (const listener of this.outputListeners) {
      try { listener(record, chunk); } catch { /* a listener must not break output */ }
    }
  }
}

/** At boot: actions left `running` by the previous process can't still be running
 *  (their child processes died with it), so they are marked interrupted. */
export function markInterruptedActions(): number {
  const result = getDatabase()
    .prepare("UPDATE actions SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
  pruneActionLogs();
  return result.changes;
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
