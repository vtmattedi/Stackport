import { ECDH } from "crypto";
import webpush from "web-push";
import { getDatabase } from "../config/database";
import { config } from "../config/env";
import { decryptSecret, encryptSecret } from "../utils/crypto";
import { logger } from "../utils/logger";
import { PUSH_EVENT_TYPES, type NotificationEventType, type StackportNotification } from "./notificationTypes";

interface PushConfigRow {
  enabled: number;
  subject: string;
  events_json: string;
  vapid_public_key: string;
  vapid_private_key_enc: string;
  updated_at: string;
}

interface SubscriptionRow {
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

export interface PushConfig {
  supported: boolean;
  enabled: boolean;
  subject: string;
  events: Record<NotificationEventType, boolean>;
  vapidPublicKey: string;
}

/** Generated automatically and encrypted with the same host secret as credentials.
 *  Stored in the persistent DB so install, update, repair and backup preserve it. */
function identity(): PushConfigRow {
  const db = getDatabase();
  let row = db.prepare("SELECT * FROM push_config WHERE id = 1").get() as PushConfigRow | undefined;
  if (!row) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare(`INSERT OR IGNORE INTO push_config
      (id, subject, vapid_public_key, vapid_private_key_enc) VALUES (1, ?, ?, ?)`)
      .run(config.certbotEmail ? `mailto:${config.certbotEmail}` : "", keys.publicKey, encryptSecret(keys.privateKey));
    row = db.prepare("SELECT * FROM push_config WHERE id = 1").get() as PushConfigRow;
  }
  return row;
}

export function getPushConfig(): PushConfig {
  const row = identity();
  const saved = JSON.parse(row.events_json) as Partial<Record<NotificationEventType, boolean>>;
  return {
    supported: true,
    enabled: !!row.enabled,
    subject: row.subject,
    events: Object.fromEntries(PUSH_EVENT_TYPES.map((type) => [type, saved[type] !== false])) as Record<NotificationEventType, boolean>,
    vapidPublicKey: row.vapid_public_key,
  };
}

export function updatePushConfig(input: unknown): PushConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid push settings");
  const data = input as Record<string, unknown>;
  const current = getPushConfig();
  if (data["enabled"] !== undefined && typeof data["enabled"] !== "boolean") throw new Error("Enabled must be a boolean");
  if (data["subject"] !== undefined && typeof data["subject"] !== "string") throw new Error("Enter a contact email or HTTPS URL");
  let subject = typeof data["subject"] === "string" ? data["subject"].trim() : current.subject;
  if (subject.includes("@") && !subject.includes(":")) subject = `mailto:${subject}`;
  if (subject && !/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) {
    let url: URL;
    try { url = new URL(subject); } catch { throw new Error("Enter a contact email or HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost") throw new Error("Enter a contact email or public HTTPS URL");
  }
  if (subject.length > 300) throw new Error("Contact address is too long");
  const enabled = (data["enabled"] as boolean | undefined) ?? current.enabled;
  if (enabled && !subject) throw new Error("A contact email or HTTPS URL is required to enable browser push");
  const events = { ...current.events };
  if (data["events"] !== undefined) {
    if (!data["events"] || typeof data["events"] !== "object" || Array.isArray(data["events"])) throw new Error("Invalid event preferences");
    for (const [key, value] of Object.entries(data["events"])) {
      if (!PUSH_EVENT_TYPES.includes(key as NotificationEventType) || typeof value !== "boolean") throw new Error("Invalid event preference");
      events[key as NotificationEventType] = value;
    }
  }
  getDatabase().prepare("UPDATE push_config SET enabled = ?, subject = ?, events_json = ?, updated_at = ? WHERE id = 1")
    .run(enabled ? 1 : 0, subject, JSON.stringify(events), new Date().toISOString());
  return getPushConfig();
}

function safeSubscription(row: SubscriptionRow): object {
  return { id: row.id, label: row.label, createdAt: row.created_at, updatedAt: row.updated_at,
    lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at };
}

export function listPushSubscriptions(): object[] {
  return (getDatabase().prepare("SELECT * FROM push_subscriptions ORDER BY id DESC").all() as SubscriptionRow[]).map(safeSubscription);
}

function validateKey(value: unknown, length: number): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || Buffer.from(value, "base64url").length !== length) {
    throw new Error("Invalid browser subscription key");
  }
  return value;
}

export function savePushSubscription(input: unknown, userAgent?: string): object {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid browser subscription");
  const { endpoint, keys, label } = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; label?: unknown };
  if (typeof endpoint !== "string" || endpoint.length > 4096) throw new Error("Invalid push endpoint");
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Invalid push endpoint"); }
  // Accept browser push providers, never arbitrary hosts supplied in a request.
  const knownHost = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com"].includes(url.hostname)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !knownHost) {
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
  return getDatabase().prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes > 0;
}

export interface PushDeliveryResult { id: number; label: string; ok: boolean; expired?: boolean; error?: string }
export type PushSender = typeof webpush.sendNotification;

export async function sendWebPushNotification(
  event: StackportNotification,
  options: { subscriptionId?: number; send?: PushSender } = {},
): Promise<PushDeliveryResult[]> {
  const settings = getPushConfig();
  if (!settings.enabled || (event.type !== "test" && !settings.events[event.type])) return [];
  const row = identity();
  const db = getDatabase();
  const subscriptions = (options.subscriptionId === undefined
    ? db.prepare("SELECT * FROM push_subscriptions").all()
    : db.prepare("SELECT * FROM push_subscriptions WHERE id = ?").all(options.subscriptionId)) as SubscriptionRow[];
  // Only concise metadata constructed by the server goes to browser push services.
  const payload = JSON.stringify({ title: event.title, body: event.body, url: event.url,
    tag: `${event.type}:${event.projectId ?? "system"}`, createdAt: event.createdAt });
  const results: PushDeliveryResult[] = [];
  for (let offset = 0; offset < subscriptions.length; offset += 4) {
    results.push(...await Promise.all(subscriptions.slice(offset, offset + 4).map(async (subscription): Promise<PushDeliveryResult> => {
      let result: PushDeliveryResult = { id: subscription.id, label: subscription.label, ok: true };
      try {
        await (options.send ?? webpush.sendNotification)(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload,
          { vapidDetails: { subject: row.subject, publicKey: row.vapid_public_key, privateKey: decryptSecret(row.vapid_private_key_enc) },
            timeout: 10_000, TTL: 300, urgency: event.severity === "info" ? "normal" : "high" },
        );
        db.prepare("UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?").run(new Date().toISOString(), subscription.id);
      } catch (error) {
        const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : null;
        const expired = status === 404 || status === 410;
        const message = expired ? "Subscription expired; enable this browser again" : status ? `Push service returned HTTP ${status}` : "Push delivery failed; retry later";
        if (expired) deletePushSubscription(subscription.id);
        else db.prepare("UPDATE push_subscriptions SET last_failure_at = ? WHERE id = ?").run(new Date().toISOString(), subscription.id);
        result = { ...result, ok: false, expired, error: message };
        logger.warn({ subscriptionId: subscription.id, status }, "notification.web-push.failed");
      }
      db.prepare(`INSERT INTO notification_logs (event_type, channel, recipient, subject, result, error_message, project_name)
        VALUES (?, 'web_push', ?, ?, ?, ?, ?)`)
        .run(event.type, `Browser #${subscription.id}`, event.title, result.ok ? "ok" : "error", result.error ?? null, event.projectName ?? null);
      return result;
    })));
  }
  return results;
}
