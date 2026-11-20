import type { NextFunction, Request, Response } from "express";
import { resourceMetadataUrl } from "../oauth/router";
import { verifyApiToken, type ApiToken, type ApiTokenScope } from "../apiTokens";

declare global {
  namespace Express {
    interface Request {
      apiToken?: ApiToken;
    }
  }
}

/** Accepts only API tokens (`spk_…`). Admin session tokens are never valid here, and
 *  API tokens are never valid on /api (requireAuth only accepts session tokens), so
 *  the two can't stand in for each other. */
export function requireApiToken(scope: ApiTokenScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const raw = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = raw ? verifyApiToken(raw, scope) : null;
    if (!token) {
      // Tells an OAuth-capable MCP client where to start (RFC 9728), so adding the bare URL is enough.
      const metadata = resourceMetadataUrl(req);
      if (metadata) res.set("WWW-Authenticate", `Bearer resource_metadata="${metadata}"`);
      res.status(401).json({ error: "A valid API token is required" });
      return;
    }
    req.apiToken = token;
    next();
  };
}
