import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import { config } from "./config/env";
import { globalLimiter } from "./application/http/rateLimiter";
import { errorHandler } from "./application/http/errorHandler";
import router from "./application/http/routes";
import githubHooksRouter from "./modules/automation/routes/githubHooks";
import mcpRouter from "./transports/mcp/http";
import controlRouter from "./modules/peers/controlRouter";
import { getReadiness } from "./modules/maintenance/readiness";
import { runningSha } from "./modules/maintenance/version";
import { createTrustedProxy } from "./modules/ingress/trustedProxy";
import { logger } from "./shared/logger";

const app = express();

// This app always sits behind its own self-managed nginx. Without this, Express
// ignores the X-Forwarded-For header nginx sets and falls back to the raw socket
// peer for req.ip — nginx's own connection for every request, from every real
// client. That silently breaks anything keyed on req.ip: the rate limiters below
// become one bucket shared by all traffic instead of per-client, and
// routes/auth.ts's audit-log IP field records nginx's address for every login.
//
// Nginx reaches the app over the stack's own network, never stackport-proxy (S3). Only
// loopback and the nginx container's address may set X-Forwarded-For; any other peer
// is taken at its socket address, so a container cannot claim a client address to dodge
// the login rate limit (S4). The address is looked up by name and refreshed, because it
// changes when nginx restarts: see modules/ingress/trustedProxy.ts.
export const trustedProxy = createTrustedProxy({
  host: config.trustedProxyHost,
  onError: (error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, "trusted-proxy.lookup-failed"),
});
app.set("trust proxy", trustedProxy.trust);

/** helmet's defaults, with one change: a form may be posted to the configured GitHub, which is how an App is registered from a
 *  manifest (the browser posts the manifest to GitHub's registration page). Everything else stays at `'self'`. */
export function securityHeaders(githubWebUrl: string = config.githubWebUrl): ReturnType<typeof helmet> {
  let origin: string | null = null;
  try { origin = new URL(githubWebUrl).origin; } catch { /* an invalid setting adds nothing */ }
  return helmet(origin ? { contentSecurityPolicy: { directives: { "form-action": ["'self'", origin] } } } : undefined);
}

app.use(securityHeaders());

app.use(
  cors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: ["X-Auth-Token"],
  })
);

// GitHub webhook deliveries: own rate limit and raw-body parsing, so they go before both.
app.use("/api/hooks", githubHooksRouter);
// Stackport Control (sp-control/v1): instance-to-instance, authenticated per request by a pairing key, never by a session. It reads its
// own body (the signature covers the exact bytes), so it must come before the JSON parser below, and it is still rate limited.
app.use("/control", globalLimiter, controlRouter);
app.use(globalLimiter);
app.use(
  express.json({
    limit: "10kb",
    // Stash raw body buffer so the webhook trigger route can verify HMAC signatures
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verify: (req: any, _res, buf: Buffer) => { req.rawBody = buf; },
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Stricter than /health: `stackport update` waits for this before accepting a new
// version. Only pass/fail per check is public; details go to the server log.
app.get("/health/ready", async (_req, res) => {
  const readiness = await getReadiness();
  const failed = Object.entries(readiness.checks).filter(([, c]) => !c.ok);
  for (const [name, c] of failed) logger.warn({ check: name, detail: c.detail ?? "no detail" }, "readiness check failed");
  res.status(readiness.ok ? 200 : 503).json({
    status: readiness.ok ? "ready" : "not-ready",
    checks: Object.fromEntries(Object.entries(readiness.checks).map(([name, c]) => [name, c.ok])),
  });
});

app.use("/mcp", mcpRouter);
app.use("/api", router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// In production the compiled output lives at dist/app.js, so ../client/dist resolves correctly.
// In development, Vite serves the frontend on its own port with a proxy to this server.
if (config.nodeEnv === "production") {
  const clientDist = path.join(__dirname, "../client/dist");
  // The PWA polls this to notice a new deploy (client/src/pwa.ts). The build's own
  // version.json only changes when package.json does; the commit changes every release.
  app.get("/version.json", (_req, res) => {
    res.set("Cache-Control", "no-store").json({version: runningSha() ?? "unknown"});
  });
  // Worker scripts and navigation HTML must revalidate on every request.
  // Fingerprinted Vite assets are immutable and safe to cache for a year.
  app.use(express.static(clientDist, {
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      if (name === "index.html" || name === "sw.js" || name === "registerSW.js" || name === "manifest.webmanifest") {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      } else if (filePath.includes(`${path.sep}assets${path.sep}`) && /-[a-zA-Z0-9_-]{8,}\./.test(name)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));
  app.use((_req, res, next) => {
    res.sendFile(path.join(clientDist, "index.html"), (err?: Error) => {
      if (err) next(err);
    });
  });
}

app.use(errorHandler);

export default app;
