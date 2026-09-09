import crypto from "crypto";
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { auditLog } from "../utils/logger";
import { authLimiter } from "../middleware/rateLimiter";
import { requireSetupAuth } from "../middleware/setupAuth";
import { issueSetupToken, SETUP_TOKEN_TTL_S } from "../services/setupTokens";
import { invalidateAuthTokens } from "../services/authTokens";
import { disconnectUserSockets } from "../services/realtime";
import {
  findActiveCredential,
  consumeCredential,
  markInitialized,
  isInitialized,
  getActiveAdminUsername,
  type SetupCredentialKind,
} from "../services/installation";

const router = Router();

// Same purpose as admin.ts's NO_ADMIN_PLACEHOLDER_HASH — keeps bcrypt.compare
// running (constant-time-ish) even when there's no live credential to check
// against, rather than short-circuiting on a missing row.
const NO_CREDENTIAL_PLACEHOLDER_HASH = bcrypt.hashSync(crypto.randomUUID(), 12);

function parseCredentials(body: unknown): { username: string; password: string } | null {
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string" || !username.trim()) return null;
  return { username: username.trim(), password };
}

router.get("/status", (_req: Request, res: Response): void => {
  res.json({ initialized: isInitialized() });
});

// Public — bootstrap (pre-init) and admin-recovery (post-init) share this one
// login step. Which credential kind is "live" is fully determined by
// isInitialized(): only one of the two ever has an active row by construction
// (bootstrap is consumed the moment setup completes; recovery only exists
// post-init, generated on demand by `stackport admin-recovery`).
router.post("/login", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = parseCredentials(req.body);
  if (!parsed) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  const kind: SetupCredentialKind = isInitialized() ? "recovery" : "bootstrap";
  const credential = findActiveCredential(kind);

  if (!credential || parsed.username !== credential.username) {
    await bcrypt.compare(parsed.password, NO_CREDENTIAL_PLACEHOLDER_HASH);
    auditLog(parsed.username, "setup.login", "setup", "fail", { ip: req.ip, kind });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const passwordMatch = await bcrypt.compare(parsed.password, credential.password_hash);
  if (!passwordMatch) {
    auditLog(parsed.username, "setup.login", "setup", "fail", { ip: req.ip, kind });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = issueSetupToken(kind, credential.username);
  auditLog(parsed.username, "setup.login", "setup", "ok", { ip: req.ip, kind });
  res.json({ token, kind, expiresIn: SETUP_TOKEN_TTL_S });
});

// Bootstrap-only — creates the real superadmin and consumes the bootstrap
// credential. Restricted-session enforcement is entirely server-side
// (requireSetupAuth("bootstrap")), not just a frontend redirect.
router.post("/admin", requireSetupAuth("bootstrap"), async (req: Request, res: Response): Promise<void> => {
  const parsed = parseCredentials(req.body);
  if (!parsed) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  if (parsed.password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const credential = findActiveCredential("bootstrap");
  if (!credential || credential.username !== req.setupAuth?.username) {
    res.status(409).json({ error: "Bootstrap session is no longer valid. Log in again." });
    return;
  }

  const passwordHash = await bcrypt.hash(parsed.password, 12);
  markInitialized(parsed.username, passwordHash);
  consumeCredential(credential.id);
  invalidateAuthTokens();

  auditLog(parsed.username, "setup.create-admin", "admin", "ok", { ip: req.ip });
  res.json({ ok: true });
});

// Recovery-only — resets the (single) admin identity's credentials on an
// already-initialized install. Generating the recovery credential itself never
// happens over HTTP (see cli/adminRecovery.ts) — this route only completes a
// recovery that a root operator already started via `stackport admin-recovery`.
router.post("/recovery", requireSetupAuth("recovery"), async (req: Request, res: Response): Promise<void> => {
  const parsed = parseCredentials(req.body);
  if (!parsed) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  if (parsed.password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const credential = findActiveCredential("recovery");
  if (!credential || credential.username !== req.setupAuth?.username) {
    res.status(409).json({ error: "Recovery session is no longer valid." });
    return;
  }

  const previousUsername = getActiveAdminUsername();
  const passwordHash = await bcrypt.hash(parsed.password, 12);
  markInitialized(parsed.username, passwordHash);
  consumeCredential(credential.id);
  invalidateAuthTokens();
  if (previousUsername) disconnectUserSockets(previousUsername, "admin-recovery");

  auditLog(parsed.username, "setup.recovery", "admin", "ok", { ip: req.ip });
  res.json({ ok: true });
});

export default router;
