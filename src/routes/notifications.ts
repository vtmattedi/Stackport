import { Router } from "express";
import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { requireAuth } from "../middleware/auth";
import { createEmailProvider } from "../services/email";
import { renderTestNotificationEmail } from "../services/emailTemplates";

const router = Router();
router.use(requireAuth);

interface NotificationConfigRow {
  id: number;
  enabled: number;
  provider: string;
  credential_id: number | null;
  from_address: string;
  to_address: string;
  updated_at: string;
}

interface NotificationConfigResponse {
  enabled: boolean;
  provider: string;
  hasApiKey: boolean;
  credentialId: number | null;
  fromAddress: string;
  toAddress: string;
  updatedAt: string;
}

function rowToConfig(row: NotificationConfigRow): NotificationConfigResponse {
  return {
    enabled: !!row.enabled,
    provider: row.provider,
    hasApiKey: row.credential_id != null,
    credentialId: row.credential_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    updatedAt: row.updated_at,
  };
}

function resolveApiKeySecret(credentialId: number): string | null {
  const row = getDatabase()
    .prepare("SELECT secret_enc FROM credentials WHERE id = ? AND type = 'api_key'")
    .get(credentialId) as { secret_enc: string } | undefined;
  if (!row) return null;
  try {
    return decryptSecret(row.secret_enc);
  } catch {
    return null;
  }
}

router.get("/", (_req, res) => {
  const row = getDatabase()
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow | undefined;

  if (!row) {
    res.json({ enabled: false, provider: "resend", hasApiKey: false, credentialId: null, fromAddress: "", toAddress: "", updatedAt: null });
    return;
  }
  res.json(rowToConfig(row));
});

router.put("/", (req, res) => {
  const { enabled, provider, credentialId, fromAddress, toAddress } = req.body as {
    enabled?: boolean;
    provider?: string;
    credentialId?: number | null;
    fromAddress?: string;
    toAddress?: string;
  };

  const db = getDatabase();
  const existing = db
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow | undefined;
  const now = new Date().toISOString();

  if (credentialId != null) {
    const cred = db.prepare("SELECT id FROM credentials WHERE id = ? AND type = 'api_key'").get(credentialId);
    if (!cred) {
      res.status(400).json({ error: "API key credential not found" });
      return;
    }
  }

  const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : (existing?.enabled ?? 0);
  const newProvider = provider ?? existing?.provider ?? "resend";
  const newFrom = fromAddress !== undefined ? fromAddress : (existing?.from_address ?? "");
  const newTo = toAddress !== undefined ? toAddress : (existing?.to_address ?? "");
  const newCredentialId = credentialId !== undefined ? credentialId : (existing?.credential_id ?? null);

  if (existing) {
    db.prepare(
      "UPDATE notification_config SET enabled = ?, provider = ?, credential_id = ?, from_address = ?, to_address = ?, updated_at = ? WHERE id = 1"
    ).run(newEnabled, newProvider, newCredentialId, newFrom, newTo, now);
  } else {
    db.prepare(
      "INSERT INTO notification_config (id, enabled, provider, credential_id, from_address, to_address, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)"
    ).run(newEnabled, newProvider, newCredentialId, newFrom, newTo, now);
  }

  const updated = db
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow;
  res.json(rowToConfig(updated));
});

router.post("/test", async (_req, res) => {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM notification_config WHERE id = 1")
    .get() as NotificationConfigRow | undefined;

  const apiKey = row?.credential_id != null ? resolveApiKeySecret(row.credential_id) : null;
  if (!apiKey || !row?.to_address || !row.from_address) {
    res.status(400).json({ error: "Notification not fully configured (API key, from, and to address required)" });
    return;
  }

  const subject = "[Test] StackPort notification";

  try {
    const provider = createEmailProvider(row.provider, apiKey, row.from_address);
    await provider.send({
      to: row.to_address,
      subject,
      html: renderTestNotificationEmail(),
    });
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result) VALUES (?, ?, ?, ?)"
    ).run("test", row.to_address, subject, "ok");
    res.json({ ok: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Failed to send test email";
    db.prepare(
      "INSERT INTO notification_logs (event_type, recipient, subject, result, error_message) VALUES (?, ?, ?, ?, ?)"
    ).run("test", row.to_address, subject, "error", errMsg);
    res.status(500).json({ error: errMsg });
  }
});

router.get("/logs", (_req, res) => {
  const rows = getDatabase()
    .prepare("SELECT * FROM notification_logs ORDER BY sent_at DESC LIMIT 50")
    .all();
  res.json(rows);
});

export default router;
