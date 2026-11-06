import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config/env";
import { auditLog } from "../utils/logger";
import { authLimiter } from "../middleware/rateLimiter";
import { getActivePasswordHash } from "./admin";
import { requireAuth } from "../middleware/auth";
import { invalidateAuthToken, issueAuthToken } from "../services/authTokens";
import { buildClearedSessionCookie, buildSessionCookie, CLIENT_HEADER, CLIENT_HEADER_VALUE } from "../services/sessionCookie";
import { getActiveAdminUsername } from "../services/installation";

const router = Router();

router.post("/login", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as { username?: unknown; password?: unknown };

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  const usernameMatch = username === getActiveAdminUsername();
  // Always run bcrypt comparison regardless of username to prevent timing attacks.
  // getActivePasswordHash checks app_meta first (set via change-password), falls back to env.
  const passwordMatch = await bcrypt.compare(password, getActivePasswordHash());

  if (!usernameMatch || !passwordMatch) {
    auditLog(username, "login", "admin", "fail", { ip: req.ip });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = issueAuthToken(username);

  auditLog(username, "login", "admin", "ok", { ip: req.ip });
  res.append("Set-Cookie", buildSessionCookie(token, { secure: req.secure, maxAgeSeconds: config.sessionIdleHours * 3600 }));
  // The web app lives on the cookie and never sees the token; scripts that send no
  // client header get it to use as a bearer token.
  const fromWebApp = req.get(CLIENT_HEADER) === CLIENT_HEADER_VALUE;
  res.json({ ...(fromWebApp ? {} : { token }), expiresInHours: config.sessionIdleHours, maxHours: config.sessionMaxHours });
});

router.post("/logout", requireAuth, (req: Request, res: Response): void => {
  if (req.authTokenId) {
    invalidateAuthToken(req.authTokenId);
  }
  auditLog(req.user ?? "unknown", "logout", "admin", "ok", { ip: req.ip });
  res.append("Set-Cookie", buildClearedSessionCookie(req.secure));
  res.status(204).end();
});

export default router;
