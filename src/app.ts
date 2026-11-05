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
import { getReadiness } from "./modules/maintenance/readiness";
import { runningSha } from "./modules/maintenance/version";

const app = express();

// This app always sits behind its own self-managed nginx. Without this, Express
// ignores the X-Forwarded-For header nginx sets and falls back to the raw socket
// peer for req.ip — nginx's own connection for every request, from every real
// client. That silently breaks anything keyed on req.ip: the rate limiters below
// become one bucket shared by all traffic instead of per-client, and
// routes/auth.ts's audit-log IP field records nginx's address for every login.
//
// Nginx reaches the app over the private stackport-proxy Docker network.
// Trust the private address range and local maintenance requests.
//
// Residual tradeoff: any other container joined to stackport-proxy (i.e. any
// managed project's routed service, joined so nginx can reach it — see
// composeNetworking.ts) is also inside this trusted range, so a compromised
// project container could spoof X-Forwarded-For for its own direct requests to
// this app. That only affects req.ip-derived observability (audit-log IP,
// rate-limit bucketing) — it cannot forge auth — and reaching this container at
// all already requires code execution inside some project StackPort itself
// deployed. A tighter fix would mean trusting nginx by identity rather than by
// network position; not worth the added complexity for what it buys today.
app.set("trust proxy", ["loopback", "uniquelocal"]);

app.use(helmet());

app.use(
  cors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
