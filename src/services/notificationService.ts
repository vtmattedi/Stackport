import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { createEmailProvider } from "./email";
import { renderDeployBlockedEmail, renderHealthCheckFailureEmail } from "./emailTemplates";
import { logger } from "../utils/logger";

interface NotificationConfigRow {
  enabled: number;
  provider: string;
  credential_id: number | null;
  from_address: string;
  to_address: string;
}

export async function notifyHealthCheckFailure(
  projectName: string,
  url: string,
  responseMs: number | null,
): Promise<void> {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow | undefined;

  if (!row?.enabled || !row.credential_id || !row.to_address || !row.from_address) return;

  const credRow = db
    .prepare("SELECT secret_enc FROM credentials WHERE id = ? AND type = 'api_key'")
    .get(row.credential_id) as { secret_enc: string } | undefined;
  if (!credRow) return;

  const subject = `[Alert] ${projectName} health check failed`;
  const occurredAt = new Date();

  try {
    const apiKey = decryptSecret(credRow.secret_enc);
    const provider = createEmailProvider(row.provider, apiKey, row.from_address);
    await provider.send({
      to: row.to_address,
      subject,
      html: renderHealthCheckFailureEmail({ projectName, url, responseMs, occurredAt }),
    });
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, project_name) VALUES (?, ?, ?, ?, ?)"
    ).run("health_check", row.to_address, subject, "ok", projectName);
    logger.info({ project: projectName, url }, "notification.health-check.sent");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, error_message, project_name) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("health_check", row.to_address, subject, "error", errMsg, projectName);
    logger.error({ err, project: projectName }, "notification.health-check.send-failed");
  }
}

export async function notifyDeployBlocked(projectName: string, reason: string): Promise<void> {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow | undefined;

  if (!row?.enabled || !row.credential_id || !row.to_address || !row.from_address) return;

  const credRow = db
    .prepare("SELECT secret_enc FROM credentials WHERE id = ? AND type = 'api_key'")
    .get(row.credential_id) as { secret_enc: string } | undefined;
  if (!credRow) return;

  const subject = `[Alert] ${projectName} automatic deploy blocked`;
  const occurredAt = new Date();

  try {
    const apiKey = decryptSecret(credRow.secret_enc);
    const provider = createEmailProvider(row.provider, apiKey, row.from_address);
    await provider.send({
      to: row.to_address,
      subject,
      html: renderDeployBlockedEmail({ projectName, reason, occurredAt }),
    });
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, project_name) VALUES (?, ?, ?, ?, ?)"
    ).run("deploy_blocked", row.to_address, subject, "ok", projectName);
    logger.info({ project: projectName, reason }, "notification.deploy-blocked.sent");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, error_message, project_name) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("deploy_blocked", row.to_address, subject, "error", errMsg, projectName);
    logger.error({ err, project: projectName }, "notification.deploy-blocked.send-failed");
  }
}
