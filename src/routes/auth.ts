import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config/env";
import { auditLog } from "../utils/logger";
import { authLimiter } from "../middleware/rateLimiter";
import { getActivePasswordHash } from "./admin";
import { requireAuth } from "../middleware/auth";
import { invalidateAuthToken, issueAuthToken } from "../services/authTokens";
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
  res.json({ token, expiresIn: config.jwtExpiry });
});

router.post("/logout", requireAuth, (req: Request, res: Response): void => {
  if (req.authTokenId) {
    invalidateAuthToken(req.authTokenId);
  }
  auditLog(req.user ?? "unknown", "logout", "admin", "ok", { ip: req.ip });
  res.status(204).end();
});

export default router;
