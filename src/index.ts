import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import app from "./app";
import { config } from "./config/env";
import { closeDatabase, initializeDatabase } from "./config/database";
import { healthChecker } from "./services/healthChecker";
import { SocketManager } from "./services/socketManager";
import { githubPoller } from "./services/githubPoller";
import { hardwareSampler } from "./services/hardwareSampler";
import { projectResourceSampler } from "./services/projectResourceSampler";
import { dockerStorageMonitor } from "./services/dockerStorageMonitor";
import { certbotRenewalMonitor } from "./services/certbotRenewalMonitor";
import { ensureBootstrapCredential } from "./services/installation";
import { ensureAppIngress } from "./services/appIngress";

try {
  initializeDatabase();
  ensureBootstrapCredential();
  void ensureAppIngress();
  healthChecker.start();
  githubPoller.start();
  hardwareSampler.start();
  projectResourceSampler.start();
  dockerStorageMonitor.start();
  certbotRenewalMonitor.start();

  const httpServer = createServer(app);

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
      methods: ["GET", "POST"],
    },
  });

  const socketManager = new SocketManager(io);

  function shutdown(signal: string): void {
    // eslint-disable-next-line no-console
    console.log(`[server] ${signal} received - shutting down gracefully`);
    io.close();
    socketManager.stop();
    githubPoller.stop();
    hardwareSampler.stop();
    projectResourceSampler.stop();
    dockerStorageMonitor.stop();
    certbotRenewalMonitor.stop();
    httpServer.close(() => {
      healthChecker.stop();
      closeDatabase();
      // eslint-disable-next-line no-console
      console.log("[server] clean exit");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[server] shutdown timeout - forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }

  httpServer.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] running on port ${config.port} (${config.nodeEnv})`);
  });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
} catch (err: unknown) {
  console.error("[db] failed to initialize:", err);
  process.exit(1);
}
