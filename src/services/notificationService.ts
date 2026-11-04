import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { createEmailProvider } from "./email";
import { renderDeployBlockedEmail, renderDeployUnhealthyEmail, renderHealthCheckFailureEmail } from "./emailTemplates";
import { logger } from "../utils/logger";
import { sendWebPushNotification } from "./webPush";
import type { StackportNotification } from "./notificationTypes";

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

/** Channels are independent and delivery never rejects a deploy/health operation. */
export async function dispatchNotification(event: StackportNotification, channels = {
  email: sendEmailNotification,
  push: async (notification: StackportNotification): Promise<void> => { await sendWebPushNotification(notification); },
}): Promise<void> {
  await Promise.all(Object.entries(channels).map(async ([channel, send]) => {
    try { await send(event); }
    catch { logger.warn({ channel, eventType: event.type }, "notification.delivery-failed"); }
  }));
}

export async function notifyHealthCheckFailure(
  projectName: string,
  url: string,
  responseMs: number | null,
  projectId?: number,
): Promise<void> {
  await dispatchNotification({
    type: "health_check", severity: "error", title: `${projectName} is unhealthy`,
    body: "The project health check failed. Open Stackport for details.", projectName, projectId,
    url: projectId ? `/projects/${projectId}` : "/projects", createdAt: new Date().toISOString(),
    email: { subject: `[Alert] ${projectName} health check failed`,
      html: renderHealthCheckFailureEmail({ projectName, url, responseMs, occurredAt: new Date() }) },
  });
}

export async function notifyDeployBlocked(projectName: string, reason: string, projectId?: number): Promise<void> {
  await dispatchNotification({
    type: "deploy_blocked", severity: "warning", title: `${projectName} deployment blocked`,
    body: "An automatic deployment needs your attention. Open Stackport for details.", projectName, projectId,
    url: projectId ? `/projects/${projectId}` : "/projects", createdAt: new Date().toISOString(),
    email: { subject: `[Alert] ${projectName} automatic deploy blocked`,
      html: renderDeployBlockedEmail({ projectName, reason, occurredAt: new Date() }) },
  });
}

/** Whether a failed deploy was rolled back automatically: not attempted, succeeded, or
 *  attempted and failed (including a rolled-back revision failing its own check). */
export type DeployRollbackOutcome = "none" | "done" | "failed";

/** A deploy finished but its health check didn't pass within the grace period. */
export async function notifyDeployUnhealthy(projectName: string, commitSha: string | null, url: string, rollback: DeployRollbackOutcome, projectId?: number): Promise<void> {
  await dispatchNotification({
    type: "deploy_unhealthy", severity: "error", title: `${projectName} deployment is unhealthy`,
    body: rollback === "done" ? "The new deployment failed its health check. The previous version was restored."
      : "The deployment failed its health check. Open Stackport for details.", projectName, projectId,
    url: projectId ? `/projects/${projectId}` : "/projects", createdAt: new Date().toISOString(),
    email: { subject: `[Alert] ${projectName} deploy failed its health check`,
      html: renderDeployUnhealthyEmail({ projectName, commitSha, url, rollback, occurredAt: new Date() }) },
  });
  if (rollback === "failed") {
    await dispatchNotification({
      type: "rollback_failed", severity: "error", title: `${projectName} rollback failed`,
      body: "Automatic rollback could not restore a healthy deployment. Open Stackport for details.", projectName, projectId,
      url: projectId ? `/projects/${projectId}` : "/projects", createdAt: new Date().toISOString(),
    });
  }
}

export async function notifySystemUpdateFailed(rolledBack = false): Promise<void> {
  await dispatchNotification({ type: "system_update_failed", severity: "error", title: "Stackport update failed",
    body: rolledBack ? "The new version failed verification and was rolled back. Open Settings for details."
      : "The update could not complete. Open Settings for details.",
    url: "/settings/general", createdAt: new Date().toISOString() });
}
