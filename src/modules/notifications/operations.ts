import { getDatabase } from "../../config/database";
import { decryptSecret } from "../../shared/crypto";
import { createEmailProvider } from "./email/provider";
import { logger } from "../../shared/logger";
import type Database from "better-sqlite3";
import type { DurablePushEvent, StackportNotification } from "./types";
import { enqueuePushEvent, enqueuePushEventTx } from "./push/outbox";
import { systemUpdateFailedEvent } from "./events";
export type { DeployRollbackOutcome } from "./events";

interface NotificationConfigRow {
  enabled: number;
  provider: string;
  credential_id: number | null;
  from_address: string;
  to_address: string;
}

/** Sends one configured email and records the outcome; the public wrapper contains failures. */
async function sendEmailNotification(event: StackportNotification): Promise<void> {
  if (!event.email) return;
  const { type: eventType, projectName, email: { subject, html } } = event;
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow | undefined;

  if (!row?.enabled || !row.credential_id || !row.to_address || !row.from_address) return;

  const credRow = db
    .prepare("SELECT secret_enc FROM credentials WHERE id = ? AND type = 'api_key'")
    .get(row.credential_id) as { secret_enc: string } | undefined;
  if (!credRow) return;

  const logEvent = eventType.replace(/_/g, "-");
  try {
    const apiKey = decryptSecret(credRow.secret_enc);
    const provider = createEmailProvider(row.provider, apiKey, row.from_address);
    await provider.send({ to: row.to_address, subject, html });
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, project_name) VALUES (?, ?, ?, ?, ?)"
    ).run(eventType, row.to_address, subject, "ok", projectName ?? null);
    logger.info({ project: projectName }, `notification.${logEvent}.sent`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, error_message, project_name) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(eventType, row.to_address, subject, "error", errMsg, projectName ?? null);
    logger.error({ err, project: projectName }, `notification.${logEvent}.send-failed`);
  }
}

function durable(event: StackportNotification): DurablePushEvent {
  if (!event.eventKey || event.type === "test") throw new Error("Automatic notifications require a stable incident identity");
  return { eventKey: event.eventKey, type: event.type, severity: event.severity, title: event.title,
    body: event.body, url: event.url, projectId: event.projectId, createdAt: event.createdAt };
}

export function enqueueNotificationTx(db: Database.Database, event: StackportNotification): void {
  enqueuePushEventTx(db, durable(event));
}

export async function sendNotificationEmail(event: StackportNotification): Promise<void> {
  try { await sendEmailNotification(event); }
  catch { logger.warn({ eventType: event.type }, "notification.email.failed"); }
}

/** Synchronous persistence precedes external effects; SQLite failures remain visible.
 *  Domain producers use enqueueNotificationTx inside their own state transaction. */
export async function dispatchNotification(event: StackportNotification): Promise<void> {
  enqueuePushEvent(getDatabase(), durable(event));
  await sendNotificationEmail(event);
}

export function notifySystemUpdateFailed(operationId: string, outcome: "failed" | "rolled-back" = "failed"): Promise<void> {
  return dispatchNotification(systemUpdateFailedEvent(operationId, outcome));
}
