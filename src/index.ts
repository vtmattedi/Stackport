import { createServer } from "http";
import { markInterruptedActions } from "./modules/actions/registry";
import { Server as SocketIOServer } from "socket.io";
import app from "./app";
import { config } from "./config/env";
import { closeDatabase, initializeDatabase } from "./config/database";
import { healthChecker } from "./modules/deployments/health";
import { SocketManager } from "./transports/socket/manager";
import { githubPoller } from "./modules/automation/githubPolling";
import { resetPendingAutoDeploys } from "./modules/automation/autoDeploy";
import { hardwareSampler } from "./modules/observability/samplers/hardware";
import { projectResourceSampler } from "./modules/observability/samplers/projects";
import { dockerStorageMonitor } from "./modules/maintenance/storage/monitor";
import { certbotRenewalMonitor } from "./modules/ingress/certificates/renewal";
import { ensureBootstrapCredential } from "./modules/identity/installation";
import { ensureAppIngress } from "./modules/ingress/bootstrap";
import { reconcileAllTcpExposures } from "./modules/ingress/tcp";
import { startSelfUpdateNotifications, stopSelfUpdateNotifications } from "./modules/maintenance/selfUpdate";
import { getPushConfig } from "./modules/notifications/push/transport";
import { pushDeliveryWorker } from "./modules/notifications/push/worker";
import { logger } from "./shared/logger";

try {
  initializeDatabase();
  try { getPushConfig(); } catch { logger.error("push.identity.bootstrap-failed"); }
  pushDeliveryWorker.start();
  markInterruptedActions();
  ensureBootstrapCredential();
  void ensureAppIngress();
  void reconcileAllTcpExposures();
  healthChecker.start();
  resetPendingAutoDeploys();
  githubPoller.start();
  hardwareSampler.start();
  projectResourceSampler.start();
  dockerStorageMonitor.start();
  certbotRenewalMonitor.start();
  startSelfUpdateNotifications();

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
    stopSelfUpdateNotifications();
    const pushDrained = pushDeliveryWorker.stop();
    httpServer.close(() => { void pushDrained.then(() => {
      healthChecker.stop();
      closeDatabase();
      // eslint-disable-next-line no-console
      console.log("[server] clean exit");
      process.exit(0);
    }); });
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
