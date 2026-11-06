import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import { config } from "./config/env";
import { globalLimiter } from "./middleware/rateLimiter";
import { errorHandler } from "./middleware/errorHandler";
import router from "./routes";
import githubHooksRouter from "./routes/githubHooks";
import mcpRouter from "./mcp/httpServer";
import { getReadiness } from "./services/readiness";
import { runningSha } from "./services/appVersion";
import { createTrustedProxy } from "./services/trustedProxy";
import { logger } from "./utils/logger";

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
// changes when nginx restarts: see services/trustedProxy.ts.
export const trustedProxy = createTrustedProxy({
  host: config.trustedProxyHost,
  onError: (error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, "trusted-proxy.lookup-failed"),
});
app.set("trust proxy", trustedProxy.trust);

app.use(helmet());

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
  for (const [name, c] of failed) console.warn(`[ready] ${name} failed: ${c.detail ?? "no detail"}`);
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
  app.use(express.static(clientDist));
  app.use((_req, res, next) => {
    res.sendFile(path.join(clientDist, "index.html"), (err?: Error) => {
      if (err) next(err);
    });
  });
}

app.use(errorHandler);

export default app;
