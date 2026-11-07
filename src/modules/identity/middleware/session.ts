import { Request, Response, NextFunction } from "express";
import { config } from "../../../config/env";
import { refreshAuthToken, verifyStoredAuthToken } from "../sessions";
import { buildSessionCookie, CLIENT_HEADER, passesCsrfCheck, readCookie, SESSION_COOKIE } from "../sessionCookie";

// Global augmentation — works with both tsc and ts-node since this file is always imported
declare global {
  namespace Express {
    interface Request {
      user?: string;
      authTokenId?: string;
      rawBody?: Buffer;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  // A bearer token is explicit; the cookie is ambient, so it gets the CSRF check (S6).
  const cookie = bearer ? null : readCookie(req.headers.cookie, SESSION_COOKIE);
  const token = bearer ?? cookie;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (cookie && !passesCsrfCheck(req.method, req.get(CLIENT_HEADER))) {
    res.status(403).json({ error: "Missing request header" });
    return;
  }
  try {
    const verified = verifyStoredAuthToken(token);
    if (!verified) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    req.user = verified.username;
    req.authTokenId = verified.tokenId;
    const refreshed = refreshAuthToken(verified.username, verified.tokenId);
    if (cookie) {
      res.append("Set-Cookie", buildSessionCookie(refreshed, { secure: req.secure, maxAgeSeconds: config.sessionIdleHours * 3600 }));
    } else {
      res.setHeader("X-Auth-Token", refreshed);
    }
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
