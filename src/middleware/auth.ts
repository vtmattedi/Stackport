import { Request, Response, NextFunction } from "express";
import { refreshAuthToken, verifyStoredAuthToken } from "../services/authTokens";

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
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = header.slice(7);
  try {
    const verified = verifyStoredAuthToken(token);
    if (!verified) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    req.user = verified.username;
    req.authTokenId = verified.tokenId;
    res.setHeader("X-Auth-Token", refreshAuthToken(verified.username, verified.tokenId));
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
