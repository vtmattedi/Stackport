import type { NextFunction, Request, RequestHandler, Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { getNginxAppConfig } from "../../ingress/nginx/appConfig";
import { oauthProvider } from "./provider";

/**
 * The OAuth endpoints MCP clients discover from /mcp: /.well-known metadata, /register, /authorize, /token and /revoke. They sit at the
 * root of the host, which is where the specification says clients look.
 *
 * The issuer comes from configuration, never from a request header: it is the admin hostname when one is set, and otherwise only a
 * loopback address (development, and a host reached through an SSH tunnel). A Host header chosen by the caller would otherwise decide the
 * issuer in the discovery metadata. Without either, OAuth is simply not offered and the request falls through untouched.
 */

export const OAUTH_SCOPES = ["read", "write", "logs"];

/** Only these paths belong to OAuth. Everything else skips this module before any lookup, so it costs the rest of the app nothing. */
const OAUTH_PATH = /^\/(?:\.well-known\/oauth-(?:authorization-server|protected-resource)(?:\/.*)?|register|authorize|token|revoke)$/;

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

export function publicOrigin(req: Request): string | null {
  const app = getNginxAppConfig();
  if (app.enabled && app.domain) {
    const origin = `${app.useSsl ? "https" : "http"}://${app.domain}`;
    return URL.canParse(origin) && new URL(origin).origin === origin ? origin : null;
  }
  const host = req.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  return LOOPBACK_HOST.test(hostname) && /^[\w.[\]:]+$/.test(host) ? `${req.protocol}://${host}` : null;
}

/** The challenge a 401 from /mcp carries, so a client can find the OAuth metadata; null when OAuth is not offered. */
export function resourceMetadataUrl(req: Request): string | null {
  const origin = publicOrigin(req);
  return origin ? getOAuthProtectedResourceMetadataUrl(new URL(`${origin}/mcp`)) : null;
}

let cached: { origin: string; handler: RequestHandler } | null = null;

function routerFor(origin: string): RequestHandler {
  if (cached?.origin === origin) return cached.handler;
  const handler = mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(origin),
    resourceServerUrl: new URL(`${origin}/mcp`),
    resourceName: "Stackport",
    scopesSupported: OAUTH_SCOPES,
    // The SDK's own limiters stay on. They are built on first use rather than at startup (the issuer is only known then), which
    // express-rate-limit flags; the check is silenced because the router is cached and built once per issuer, not per request.
    authorizationOptions: { rateLimit: { validate: { creationStack: false } } },
    tokenOptions: { rateLimit: { validate: { creationStack: false } } },
    revocationOptions: { rateLimit: { validate: { creationStack: false } } },
    clientRegistrationOptions: { rateLimit: { validate: { creationStack: false } } },
  });
  cached = { origin, handler };
  return handler;
}

export const oauthRouter: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  if (!OAUTH_PATH.test(req.path)) { next(); return; }
  const origin = publicOrigin(req);
  if (!origin) { res.status(404).json({ error: "OAuth for MCP is available once Stackport has an admin hostname" }); return; }
  let handler: RequestHandler;
  try {
    handler = routerFor(origin);
  } catch {
    // The SDK refuses an http issuer other than localhost. Without HTTPS there is no OAuth; API tokens still work.
    res.status(404).json({ error: "OAuth for MCP needs Stackport to be served over HTTPS" });
    return;
  }
  handler(req, res, next);
};
