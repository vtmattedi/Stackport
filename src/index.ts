import { createServer } from "http";
import { markInterruptedActions } from "./modules/actions/registry";
import { Server as SocketIOServer } from "socket.io";
import app, { trustedProxy } from "./app";
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
import { reconcileIngressNetworks, reconcileNetworkGroups } from "./modules/deployments/operations";
import { removeLegacyIngressNetworks } from "./modules/ingress/networks";
import { startSelfUpdateNotifications, stopSelfUpdateNotifications } from "./modules/maintenance/selfUpdate";
import { getPushConfig } from "./modules/notifications/push/transport";
import { pushDeliveryWorker } from "./modules/notifications/push/worker";
import { logger } from "./shared/logger";
import { getNetworkHeadroom } from "./modules/maintenance/networkHeadroom";

/** In this order: services on the shared network first (nginx's config names them by alias), then the config,
 *  then the TCP proxies, then the per-project networks 1.3.0 left behind. */
async function startIngress(): Promise<void> {
  await reconcileIngressNetworks();
  await ensureAppIngress().catch((err: unknown) => logger.error({ err }, "ingress: nginx config at start-up failed"));
  await reconcileAllTcpExposures().catch((err: unknown) => logger.error({ err }, "ingress: TCP exposures at start-up failed"));
  await removeLegacyIngressNetworks();
}

/** The address pool is a host-wide limit, so say so in the log while there is still room (P3). */
async function warnIfNetworkPoolIsNearlyFull(): Promise<void> {
  const headroom = await getNetworkHeadroom().catch(() => null);
  if (!headroom || headroom.level === "ok") return;
  const message = `Docker has room for ${headroom.free} more networks (${headroom.used} of ${headroom.capacity} address-pool slices used). ${headroom.advice ?? ""}`;
  if (headroom.level === "critical") logger.error({ ...headroom }, message);
  else logger.warn({ ...headroom }, message);
}

try {
  initializeDatabase();
  try { getPushConfig(); } catch { logger.error("push.identity.bootstrap-failed"); }
  pushDeliveryWorker.start();
  markInterruptedActions();
  ensureBootstrapCredential();
  void startIngress();
  void warnIfNetworkPoolIsNearlyFull();
  void reconcileNetworkGroups();
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
      logger.error("shutdown timeout, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }

  // Take requests only once nginx's address is known (or the lookup has had its few seconds), so the
  // first logins are not all counted as coming from nginx and the session cookie gets its Secure flag.
  void trustedProxy.start().then(() => {
    httpServer.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`[server] running on port ${config.port} (${config.nodeEnv})`);
    });
  });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
} catch (err: unknown) {
  logger.error({ err }, "database failed to initialize");
  process.exit(1);
}
