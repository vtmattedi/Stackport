import type Database from "better-sqlite3";
import { getDatabase } from "../config/database";
import { logger } from "../utils/logger";
import { claimDueDeliveries, cleanupOldEvents, finishDelivery, getPushQueueStatus, leaseIsEligible, MAX_PUSH_ATTEMPTS, type PushLease } from "./pushOutbox";
import { deletePushSubscription, sendOnePush, type PushAttemptResult } from "./webPush";

export function nextPushAttemptAt(attempts: number, now: number, expires: number, random = Math.random(), retryAfterAt = 0): number {
  const seconds = [15, 60, 300, 900, 3600, 7200][Math.min(Math.max(0, attempts - 1), 5)];
  const backoff = seconds * 1000 * (0.8 + Math.max(0, Math.min(1, random)) * 0.4);
  return Math.min(expires, Math.max(now + backoff, Math.min(retryAfterAt, now + 7_200_000)));
}

interface WorkerDeps {
  db: () => Database.Database;
  now: () => number;
  random: () => number;
  send: (id: number, payload: string, ttl: number) => Promise<PushAttemptResult>;
}

export class PushDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private abandonCompletions = false;
  private nextCleanupAt = 0;
  private readonly deps: WorkerDeps;

  constructor(deps: Partial<WorkerDeps> = {}) {
    this.deps = { db: getDatabase, now: Date.now, random: Math.random, send: sendOnePush, ...deps };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.abandonCompletions = false;
    const tick = (): void => { void this.poll().catch(() => logger.error("push.worker.poll-failed")); };
    tick();
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
  }

  poll(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopping) return Promise.resolve();
    this.running = this.drainBatch().finally(() => { this.running = null; });
    return this.running;
  }

  private async drainBatch(): Promise<void> {
    const { db: getDb, now } = this.deps;
    const db = getDb();
    const timestamp = now();
    db.prepare(`INSERT INTO app_meta (key,value,updated_at) VALUES ('push_worker_poll_at',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(new Date(timestamp).toISOString());
    if (timestamp >= this.nextCleanupAt) {
      const deleted = cleanupOldEvents(db, timestamp);
      const logsDeleted = db.prepare(`DELETE FROM notification_logs WHERE id IN (SELECT id FROM notification_logs
        WHERE channel='web_push' AND datetime(sent_at) < datetime(?) ORDER BY id LIMIT 200)`)
        .run(new Date(timestamp - 30 * 86_400_000).toISOString()).changes;
      const warning = getPushQueueStatus(db, timestamp).queueWarning;
      if (warning) logger.warn("push.worker.queue-backlog");
      this.nextCleanupAt = timestamp + (deleted === 200 || logsDeleted === 200 ? 60_000 : 86_400_000);
    }
    const leases = claimDueDeliveries(db, timestamp);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, leases.length) }, async () => {
      while (!this.stopping && index < leases.length) await this.attempt(leases[index++]);
    }));
  }

  private async attempt(lease: PushLease): Promise<void> {
    const { db: getDb, now, send, random } = this.deps;
    const db = getDb();
    if (!leaseIsEligible(db, lease, now())) return;
    if (lease.attempts > MAX_PUSH_ATTEMPTS) { finishDelivery(db, lease, "permanent_failure", { code: "retry_limit" }, now()); return; }
    const ttl = Math.max(0, Math.floor((lease.expires_at_ms - now()) / 1000));
    if (!ttl) { finishDelivery(db, lease, "expired", { code: "event_expired" }, now()); return; }
    let result: PushAttemptResult;
    try { result = await send(lease.subscription_id!, lease.payload_json, ttl); }
    catch { result = { kind: "retry", code: "push_network_error" }; }
    if (this.abandonCompletions) return; // The DB may already be closed after bounded shutdown.
    const timestamp = now();
    db.transaction(() => {
      const kind = result.kind === "retry" && lease.attempts >= MAX_PUSH_ATTEMPTS ? "permanent_failure" : result.kind;
      const changed = finishDelivery(db, lease, kind, {
        code: kind === "permanent_failure" && result.kind === "retry" ? "retry_limit" : result.code,
        httpStatus: result.httpStatus,
        nextAttemptAt: kind === "retry" ? nextPushAttemptAt(lease.attempts, timestamp, lease.expires_at_ms, random(), result.retryAfterAt) : undefined,
      }, timestamp);
      if (changed && result.kind === "expired" && lease.subscription_id) deletePushSubscription(lease.subscription_id);
    })();
  }

  async stop(drainMs = 8000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.running?.catch(() => undefined), new Promise<void>((resolve) => { timeout = setTimeout(resolve, drainMs); })]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.abandonCompletions = true;
    }
  }
}

export const pushDeliveryWorker = new PushDeliveryWorker();
