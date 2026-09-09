import crypto from "crypto";
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware/auth";
import { getDatabase } from "../config/database";
import { config } from "../config/env";
import { auditLog } from "../utils/logger";
import { invalidateAuthTokens } from "../services/authTokens";
import { disconnectUserSockets } from "../services/realtime";

const router = Router();

// Used only when no admin exists yet at all (fresh, pre-bootstrap-completion
// install with no legacy ADMIN_PASSWORD_HASH env either) — lets getActivePasswordHash
// always return a real bcrypt hash so /auth/login's bcrypt.compare still runs
// (preserving its timing-attack mitigation) instead of branching on null, while any
// password compared against it is guaranteed to fail.
const NO_ADMIN_PLACEHOLDER_HASH = bcrypt.hashSync(crypto.randomUUID(), 12);

export function getActivePasswordHash(): string {
  const row = getDatabase()
    .prepare("SELECT value FROM app_meta WHERE key = 'admin_password_hash'")
    .get() as { value: string } | undefined;
  return row?.value ?? config.adminPasswordHash ?? NO_ADMIN_PLACEHOLDER_HASH;
}

router.post("/change-password", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };

  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "currentPassword and newPassword are required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, getActivePasswordHash());
  if (!valid) {
    auditLog(req.user ?? "unknown", "admin.change-password", "admin", "fail");
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES ('admin_password_hash', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(newHash, now);

  const username = req.user ?? "unknown";
  invalidateAuthTokens(username);
  disconnectUserSockets(username, "password-change");
  res.setHeader("X-Auth-Revoked", "1");

  auditLog(username, "admin.change-password", "admin", "ok");
  res.json({ ok: true });
});

export default router;
