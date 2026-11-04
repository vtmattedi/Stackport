import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { PUSH_EVENT_TYPES, PUSH_LIFETIME_MS, type DurablePushEvent, type NotificationEventType } from "./notificationTypes";

export const LIVE_PUSH_STATES = "'pending', 'retry', 'leased'";
export const MAX_PUSH_ATTEMPTS = 12;
export const PUSH_LEASE_MS = 60_000;
export interface PushLease {
  id: number;
  event_id: number;
  subscription_id: number | null;
  browser_label: string;
  attempts: number;
  lease_token: string;
  event_type: NotificationEventType;
  event_key: string;
  project_id: number | null;
  payload_json: string;
  expires_at_ms: number;
}

function pushEnabled(db: Database.Database, type: NotificationEventType): boolean {
  const row = db.prepare("SELECT enabled, events_json FROM push_config WHERE id = 1").get() as { enabled: number; events_json: string } | undefined;
  const preference = row && (JSON.parse(row.events_json) as Record<string, unknown>)[type];
  return !!row?.enabled && (typeof preference === "boolean" ? preference : type !== "rollback_recovered");
}

/** DB-only; callers include this in the transaction that classifies the incident. */
export function enqueuePushEventTx(db: Database.Database, event: DurablePushEvent, nowMs = Date.now()): { eventId: number | null; inserted: boolean } {
  if (event.eventKey.length > 220 || !/^[a-z_]+:[A-Za-z0-9:_-]{1,200}$/.test(event.eventKey)
    || !PUSH_EVENT_TYPES.includes(event.type) || !event.eventKey.startsWith(`${event.type}:`)) throw new Error("Invalid push event identity");
  if (!["info", "warning", "error"].includes(event.severity)) throw new Error("Invalid push severity");
  if (!/^\/(?:projects(?:\/[1-9]\d*(?:\/[a-z-]+)?)?|settings\/(?:general|notifications))$/.test(event.url)) throw new Error("Invalid push navigation path");
  if (event.projectId !== undefined && (!Number.isSafeInteger(event.projectId) || event.projectId <= 0)) throw new Error("Invalid push project ID");
  const created = Date.parse(event.createdAt);
  const expires = Math.min(created + PUSH_LIFETIME_MS[event.type], event.expiresAt ? Date.parse(event.expiresAt) : Infinity);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || created > nowMs + 60_000) throw new Error("Invalid push event lifetime");
  const text = (value: string, limit: number): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid push event text");
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
  };
  const payload = { version: 1, eventKey: event.eventKey, title: text(event.title, 160), body: text(event.body, 500),
    url: event.url, tag: event.eventKey, createdAt: new Date(created).toISOString() };
  if (Buffer.byteLength(JSON.stringify(payload)) > 3500) throw new Error("Push payload too large");
  const existing = db.prepare("SELECT id FROM push_events WHERE event_key = ?").get(event.eventKey) as { id: number } | undefined;
  if (existing) return { eventId: existing.id, inserted: false };
  if (expires <= nowMs || !pushEnabled(db, event.type)) return { eventId: null, inserted: false };
  const recipients = db.prepare("SELECT id, label FROM push_subscriptions").all() as { id: number; label: string }[];
  if (!recipients.length) return { eventId: null, inserted: false };
  const result = db.prepare(`INSERT INTO push_events
    (event_key, event_type, severity, project_id, payload_json, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`)
    .run(event.eventKey, event.type, event.severity, event.projectId ?? null, JSON.stringify(payload), created, expires);
  if (!result.changes) return { eventId: (db.prepare("SELECT id FROM push_events WHERE event_key = ?").get(event.eventKey) as { id: number }).id, inserted: false };
  const id = Number(result.lastInsertRowid);
  const insert = db.prepare(`INSERT INTO push_deliveries
    (event_id, subscription_id, browser_label, next_attempt_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)`);
  for (const recipient of recipients) insert.run(id, recipient.id, recipient.label.slice(0, 100), nowMs, nowMs);
  return { eventId: id, inserted: true };
}

export function enqueuePushEvent(db: Database.Database, event: DurablePushEvent, nowMs = Date.now()): { eventId: number | null; inserted: boolean } {
  return db.transaction(() => enqueuePushEventTx(db, event, nowMs)).immediate();
}

export function cancelEvent(db: Database.Database, eventKey: string, reason: string, now = Date.now()): void {
  db.prepare("UPDATE push_events SET cancelled_at_ms = ?, cancel_reason = ? WHERE event_key = ? AND cancelled_at_ms IS NULL").run(now, reason, eventKey);
  db.prepare(`UPDATE push_deliveries SET status = 'cancelled', finished_at_ms = ?, updated_at_ms = ?,
    lease_token = NULL, lease_until_ms = NULL, last_error_code = ?
    WHERE event_id = (SELECT id FROM push_events WHERE event_key = ?) AND status IN (${LIVE_PUSH_STATES})`).run(now, now, reason, eventKey);
}

export function cancelSubscriptionDeliveries(db: Database.Database, subscriptionId: number, now = Date.now()): void {
  db.prepare(`UPDATE push_deliveries SET status = 'cancelled', finished_at_ms = ?, updated_at_ms = ?,
    lease_token = NULL, lease_until_ms = NULL, last_error_code = 'browser_removed'
    WHERE subscription_id = ? AND status IN (${LIVE_PUSH_STATES})`).run(now, now, subscriptionId);
}

export function cancelDisabledDeliveries(db: Database.Database, now = Date.now()): void {
  for (const type of PUSH_EVENT_TYPES) {
    if (pushEnabled(db, type)) continue;
    db.prepare(`UPDATE push_deliveries SET status = 'cancelled', finished_at_ms = ?, updated_at_ms = ?,
      lease_token = NULL, lease_until_ms = NULL, last_error_code = 'preference_disabled'
      WHERE status IN (${LIVE_PUSH_STATES}) AND event_id IN (SELECT id FROM push_events WHERE event_type = ?)`).run(now, now, type);
  }
}

export function claimDueDeliveries(db: Database.Database, now = Date.now(), limit = 16): PushLease[] {
  return db.transaction(() => {
    db.prepare(`UPDATE push_deliveries SET status = 'expired', finished_at_ms = ?, updated_at_ms = ?,
      lease_token = NULL, lease_until_ms = NULL, last_error_code = 'event_expired'
      WHERE status IN (${LIVE_PUSH_STATES}) AND event_id IN (SELECT id FROM push_events WHERE expires_at_ms <= ?)`)
      .run(now, now, now);
    const due = db.prepare(`SELECT id FROM push_deliveries
      WHERE (status IN ('pending', 'retry') AND next_attempt_at_ms <= ?)
         OR (status = 'leased' AND lease_until_ms <= ?)
      ORDER BY next_attempt_at_ms, id LIMIT ?`).all(now, now, Math.max(0, Math.min(16, limit))) as { id: number }[];
    const leases: PushLease[] = [];
    for (const { id } of due) {
      db.prepare(`UPDATE push_deliveries SET status = 'leased', lease_token = ?, lease_until_ms = ?,
        attempts = attempts + 1, updated_at_ms = ? WHERE id = ?`).run(randomUUID(), now + PUSH_LEASE_MS, now, id);
      leases.push(db.prepare(`SELECT d.*, e.event_type, e.event_key, e.project_id, e.payload_json, e.expires_at_ms
        FROM push_deliveries d JOIN push_events e ON e.id = d.event_id WHERE d.id = ?`).get(id) as PushLease);
    }
    return leases;
  }).immediate();
}

/** Re-read just before HTTP; cancellation clears ownership, including active leases. */
export function leaseIsEligible(db: Database.Database, lease: PushLease, now = Date.now()): boolean {
  const row = db.prepare(`SELECT d.id, e.cancelled_at_ms FROM push_deliveries d JOIN push_events e ON e.id = d.event_id
    WHERE d.id = ? AND d.status = 'leased' AND d.lease_token = ? AND d.lease_until_ms > ?`).get(lease.id, lease.lease_token, now) as { cancelled_at_ms: number | null } | undefined;
  if (!row) return false;
  let reason: string | null = null;
  if (lease.expires_at_ms - now < 1000) reason = "event_expired";
  else if (row.cancelled_at_ms !== null) reason = "event_cancelled";
  else if (!pushEnabled(db, lease.event_type)) reason = "preference_disabled";
  else if (!lease.subscription_id || !db.prepare("SELECT id FROM push_subscriptions WHERE id = ?").get(lease.subscription_id)) reason = "browser_removed";
  else if (lease.event_type === "health_check") {
    const project = db.prepare("SELECT last_status, paused, health_incident_key FROM projects WHERE id = ?").get(lease.project_id) as { last_status: string; paused: number; health_incident_key: string | null } | undefined;
    if (!project || project.paused || project.last_status !== "down" || project.health_incident_key !== lease.event_key) reason = "health_incident_resolved";
  }
  if (reason) {
    finishDelivery(db, lease, reason === "event_expired" ? "expired" : "cancelled", { code: reason }, now);
    return false;
  }
  return true;
}

export function finishDelivery(
  db: Database.Database, lease: PushLease,
  status: "accepted" | "retry" | "expired" | "cancelled" | "permanent_failure",
  outcome: { code?: string; httpStatus?: number; nextAttemptAt?: number } = {}, now = Date.now(),
): boolean {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE push_deliveries SET status = ?, next_attempt_at_ms = ?,
      lease_token = NULL, lease_until_ms = NULL, accepted_at_ms = ?, finished_at_ms = ?, last_http_status = ?,
      last_error_code = ?, updated_at_ms = ? WHERE id = ? AND status = 'leased' AND lease_token = ?`)
      .run(status, outcome.nextAttemptAt ?? now, status === "accepted" ? now : null, status === "retry" ? null : now,
        outcome.httpStatus ?? null, outcome.code ?? null, now, lease.id, lease.lease_token).changes;
    if (!changed) return false;
    if (status === "accepted") db.prepare("UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?").run(new Date(now).toISOString(), lease.subscription_id);
    else if (status === "retry" || status === "permanent_failure") db.prepare("UPDATE push_subscriptions SET last_failure_at = ? WHERE id = ?").run(new Date(now).toISOString(), lease.subscription_id);
    if (status !== "cancelled") {
      const title = (JSON.parse(lease.payload_json) as { title: string }).title;
      db.prepare(`INSERT INTO notification_logs (event_type, channel, recipient, subject, result, error_message, sent_at)
        VALUES (?, 'web_push', ?, ?, ?, ?, ?)`)
        .run(lease.event_type, `Browser #${lease.subscription_id ?? "removed"}`, title, status === "accepted" ? "ok" : "error", outcome.code ?? null, new Date(now).toISOString());
    }
    return true;
  })();
}

/** No provider attempt occurred. Keep the delivery live without spending its retry budget. */
export function suspendDelivery(db: Database.Database, lease: PushLease, now = Date.now()): void {
  db.prepare(`UPDATE push_deliveries SET status = 'retry', attempts = MAX(0, attempts - 1),
    next_attempt_at_ms = ?, lease_token = NULL, lease_until_ms = NULL,
    last_error_code = 'push_identity_unavailable', updated_at_ms = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ?`)
    .run(Math.min(lease.expires_at_ms, now + 30_000), now, lease.id, lease.lease_token);
}

export function cleanupOldEvents(db: Database.Database, now = Date.now(), batch = 200): number {
  const cutoff = now - 30 * 86_400_000;
  return db.prepare(`DELETE FROM push_events WHERE id IN (
    SELECT e.id FROM push_events e WHERE e.created_at_ms < ? AND NOT EXISTS
      (SELECT 1 FROM push_deliveries d WHERE d.event_id = e.id AND
        (d.status IN (${LIVE_PUSH_STATES}) OR d.finished_at_ms IS NULL OR d.finished_at_ms >= ?))
    ORDER BY e.id LIMIT ?)`)
    .run(cutoff, cutoff, Math.min(200, Math.max(0, batch))).changes;
}

export function getPushQueueStatus(db: Database.Database, now = Date.now()): {
  pending: number; retrying: number; leased: number; permanentFailures24h: number; accepted24h: number;
  oldestPendingAgeSeconds: number | null; lastWorkerPollAt: string | null; lastSuccessfulAcceptanceAt: string | null; queueWarning: string | null;
} {
  const counts = db.prepare(`SELECT
    SUM(status = 'pending') AS pending, SUM(status = 'retry') AS retrying, SUM(status = 'leased') AS leased,
    SUM(status = 'permanent_failure' AND finished_at_ms >= ?) AS failures,
    SUM(status = 'accepted' AND accepted_at_ms >= ?) AS accepted, MAX(accepted_at_ms) AS last_accepted
    FROM push_deliveries`).get(now - 86_400_000, now - 86_400_000) as Record<string, number | null>;
  const oldest = db.prepare(`SELECT MIN(e.created_at_ms) AS started FROM push_events e JOIN push_deliveries d ON d.event_id = e.id
    WHERE d.status IN (${LIVE_PUSH_STATES})`).get() as { started: number | null };
  const heartbeat = db.prepare("SELECT value FROM app_meta WHERE key = 'push_worker_poll_at'").get() as { value: string } | undefined;
  const subscriptionAcceptance = db.prepare("SELECT MAX(last_success_at) AS accepted FROM push_subscriptions").get() as { accepted: string | null };
  const lastAcceptance = Math.max(counts["last_accepted"] ?? 0, Date.parse(subscriptionAcceptance.accepted ?? "") || 0);
  const live = (counts["pending"] ?? 0) + (counts["retrying"] ?? 0) + (counts["leased"] ?? 0);
  return { pending: counts["pending"] ?? 0, retrying: counts["retrying"] ?? 0, leased: counts["leased"] ?? 0,
    permanentFailures24h: counts["failures"] ?? 0, accepted24h: counts["accepted"] ?? 0,
    oldestPendingAgeSeconds: oldest.started === null ? null : Math.max(0, Math.floor((now - oldest.started) / 1000)),
    lastWorkerPollAt: heartbeat?.value ?? null,
    lastSuccessfulAcceptanceAt: lastAcceptance ? new Date(lastAcceptance).toISOString() : null,
    queueWarning: live > 5000 ? "More than 5,000 push deliveries are waiting. Check worker and provider health." : null };
}
