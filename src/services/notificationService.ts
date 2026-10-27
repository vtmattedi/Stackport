import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { createEmailProvider } from "./email";
import { renderDeployBlockedEmail, renderDeployUnhealthyEmail, renderHealthCheckFailureEmail } from "./emailTemplates";
import { logger } from "../utils/logger";

interface NotificationConfigRow {
  enabled: number;
  provider: string;
  credential_id: number | null;
  from_address: string;
  to_address: string;
}

/** Sends one alert email when notifications are enabled and configured, and records
 *  the outcome in notification_logs. Never throws: a failed send is logged. */
async function sendAlert(eventType: string, projectName: string, subject: string, html: string, logFields: Record<string, unknown>): Promise<void> {
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
    ).run(eventType, row.to_address, subject, "ok", projectName);
    logger.info({ project: projectName, ...logFields }, `notification.${logEvent}.sent`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, error_message, project_name) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(eventType, row.to_address, subject, "error", errMsg, projectName);
    logger.error({ err, project: projectName }, `notification.${logEvent}.send-failed`);
  }
}

export async function notifyHealthCheckFailure(
  projectName: string,
  url: string,
  responseMs: number | null,
): Promise<void> {
  await sendAlert(
    "health_check",
    projectName,
    `[Alert] ${projectName} health check failed`,
    renderHealthCheckFailureEmail({ projectName, url, responseMs, occurredAt: new Date() }),
    { url },
  );
}

export async function notifyDeployBlocked(projectName: string, reason: string): Promise<void> {
  await sendAlert(
    "deploy_blocked",
    projectName,
    `[Alert] ${projectName} automatic deploy blocked`,
    renderDeployBlockedEmail({ projectName, reason, occurredAt: new Date() }),
    { reason },
  );
}

/** Whether a failed deploy was rolled back automatically: not attempted, succeeded, or
 *  attempted and failed (including a rolled-back revision failing its own check). */
export type DeployRollbackOutcome = "none" | "done" | "failed";

/** A deploy finished but its health check didn't pass within the grace period. */
export async function notifyDeployUnhealthy(projectName: string, commitSha: string | null, url: string, rollback: DeployRollbackOutcome): Promise<void> {
  await sendAlert(
    "deploy_unhealthy",
    projectName,
    `[Alert] ${projectName} deploy failed its health check`,
    renderDeployUnhealthyEmail({ projectName, commitSha, url, rollback, occurredAt: new Date() }),
    { url, commitSha, rollback },
  );
}
