import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { createEmailProvider } from "./email";
import { logger } from "../utils/logger";
import type Database from "better-sqlite3";
import type { DurablePushEvent, StackportNotification } from "./notificationTypes";
import { enqueuePushEvent, enqueuePushEventTx } from "./pushOutbox";
import { healthFailureEvent, deployBlockedEvent, deployUnhealthyEvent, rollbackFailedEvent, systemUpdateFailedEvent, type DeployRollbackOutcome } from "./notificationEvents";
export type { DeployRollbackOutcome } from "./notificationEvents";

interface NotificationConfigRow {
  enabled: number;
  provider: string;
  credential_id: number | null;
  from_address: string;
  to_address: string;
}

/** Sends one alert email when notifications are enabled and configured, and records
 *  the outcome in notification_logs. Never throws: a failed send is logged. */
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
export async function dispatchNotification(event: StackportNotification,
  channels?: { email: (event: StackportNotification) => Promise<void>; push: (event: StackportNotification) => Promise<void> }): Promise<void> {
  if (channels) {
    await Promise.all(Object.values(channels).map(async (send) => { try { await send(event); } catch { /* independent best-effort channels */ } }));
    return;
  }
  try { enqueuePushEvent(getDatabase(), durable(event)); }
  catch (error) { void sendNotificationEmail(event); logger.error({ eventType: event.type }, "notification.enqueue-failed"); throw error; }
  await sendNotificationEmail(event);
}

export function notifyHealthCheckFailure(name: string, url: string, responseMs: number | null, projectId: number, incidentKey: string): Promise<void> {
  return dispatchNotification(healthFailureEvent(name, url, responseMs, projectId, incidentKey));
}

export function notifyDeployBlocked(name: string, reason: string, projectId: number, attemptId: string | number): Promise<void> {
  return dispatchNotification(deployBlockedEvent(name, reason, projectId, attemptId));
}

export async function notifyDeployUnhealthy(name: string, commit: string | null, url: string, rollback: DeployRollbackOutcome,
  projectId: number, operationId: string): Promise<void> {
  await dispatchNotification(deployUnhealthyEvent(name, commit, url, rollback, projectId, operationId));
  if (rollback === "failed") await dispatchNotification(rollbackFailedEvent(name, projectId, operationId));
}

export function notifySystemUpdateFailed(operationId: string, outcome: "failed" | "rolled-back" = "failed"): Promise<void> {
  return dispatchNotification(systemUpdateFailedEvent(operationId, outcome));
}
