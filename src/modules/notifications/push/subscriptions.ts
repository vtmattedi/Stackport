import { ECDH } from "crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../../../config/database";
import { cancelSubscriptionDeliveries } from "./outbox";

export interface PushSubscriptionSummary {
  id: number;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
}

function safeSubscription(row: SubscriptionRow): PushSubscriptionSummary {
  return { id: row.id, label: row.label, createdAt: row.created_at, updatedAt: row.updated_at,
    lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at };
}

export function listPushSubscriptions(): PushSubscriptionSummary[] {
  return (getDatabase().prepare("SELECT * FROM push_subscriptions ORDER BY id DESC").all() as SubscriptionRow[]).map(safeSubscription);
}

function validateKey(value: unknown, length: number): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || Buffer.from(value, "base64url").length !== length) {
    throw new Error("Invalid browser subscription key");
  }
  return value;
}

export function allowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const known = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com"].includes(url.hostname)
      || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
    return endpoint.length <= 4096 && url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") && known;
  } catch { return false; }
}

export function savePushSubscription(input: unknown, userAgent?: string): PushSubscriptionSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid browser subscription");
  const { endpoint, keys, label } = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; label?: unknown };
  if (typeof endpoint !== "string" || endpoint.length > 4096) throw new Error("Invalid push endpoint");
  if (!allowedEndpoint(endpoint)) {
    throw new Error("Use an HTTPS subscription from a supported browser push service");
  }
  if (!keys || typeof keys !== "object") throw new Error("Missing browser subscription keys");
  const p256dh = validateKey(keys.p256dh, 65);
  try { ECDH.convertKey(Buffer.from(p256dh, "base64url"), "prime256v1"); }
  catch { throw new Error("Invalid browser public key"); }
  const auth = validateKey(keys.auth, 16);
  if (label !== undefined && (typeof label !== "string" || label.trim().length > 100)) throw new Error("Browser name must be at most 100 characters");
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  if (!existing && (db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n >= 50) throw new Error("Remove an old browser before adding another (50 browser limit)");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, user_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
    label = excluded.label, user_agent = excluded.user_agent, updated_at = excluded.updated_at`)
    .run(endpoint, p256dh, auth, typeof label === "string" && label.trim() ? label.trim() : "Browser", userAgent?.slice(0, 300) ?? null, now, now);
  return safeSubscription(db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(endpoint) as SubscriptionRow);
}

export function deletePushSubscription(id: number): boolean {
  const db = getDatabase();
  return db.transaction(() => deletePushSubscriptionTx(db, id))();
}

export function resolvePushSubscription(input: unknown): PushSubscriptionSummary | null {
  if (!input || typeof input !== "object") return null;
  const data = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof data.endpoint !== "string" || typeof data.keys?.p256dh !== "string" || typeof data.keys.auth !== "string") return null;
  const row = getDatabase().prepare("SELECT * FROM push_subscriptions WHERE endpoint = ? AND p256dh = ? AND auth = ?")
    .get(data.endpoint, data.keys.p256dh, data.keys.auth) as SubscriptionRow | undefined;
  return row ? safeSubscription(row) : null;
}

/** Runs inside the caller's transaction so delivery finalization and removal share a database. */
export function deletePushSubscriptionTx(db: Database.Database, id: number): boolean {
  cancelSubscriptionDeliveries(db, id);
  return db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes > 0;
}
