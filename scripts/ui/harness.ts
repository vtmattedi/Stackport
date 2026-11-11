import fs from "fs";
import os from "os";
import path from "path";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";

/**
 * A real Stackport on a throwaway database, for looking at the UI: the actual Express app and Socket.IO, the built client
 * (client/dist), and some seeded data. No Docker is needed; what asks Docker simply shows an empty or error state, which is
 * what the page does on a host where Docker is down.
 */

export const HARNESS_USER = "admin";
export const HARNESS_PASSWORD = "ui-harness-password";

export interface Harness {
  url: string;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-ui-"));
  const set = (key: string, value: string): void => { process.env[key] = value; };
  set("JWT_SECRET", "ui-harness-jwt-secret");
  set("WEBHOOK_SECRET", "ui-harness-webhook-secret");
  set("NODE_ENV", "production"); // the built client is served only in production
  set("SQLITE_PATH", path.join(dir, "stackport.sqlite"));
  set("DEPLOY_ROOT", path.join(dir, "repos"));
  set("SCRIPTS_DIR", path.join(dir, "scripts"));
  set("LOG_DIR", path.join(dir, "logs"));
  set("NGINX_PATH", path.join(dir, "nginx"));
  set("LOG_LEVEL", "silent");
  set("STACKPORT_POWER_KEY", "ui-harness-power-key");
  set("POWER_STATE_DIR", path.join(dir, "power-state"));
  set("ADMIN_USERNAME", HARNESS_USER);
  set("ADMIN_PASSWORD_HASH", bcrypt.hashSync(HARNESS_PASSWORD, 10));

  // The app reads its configuration when it is first imported, so it is imported only now.
  const { default: app } = await import("../../src/app");
  const { initializeDatabase, closeDatabase } = await import("../../src/config/database");
  const { Server: SocketIOServer } = await import("socket.io");
  const { SocketManager } = await import("../../src/transports/socket/manager");

  initializeDatabase();
  // Host > Power shows its reboot form when the host side is installed: this stands in for it (nothing here can reboot anything).
  fs.mkdirSync(path.join(dir, "power-state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "power-state", "ready"), "");
  await seed();

  const http: Server = createServer(app);
  const io = new SocketIOServer(http);
  const sockets = new SocketManager(io);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      sockets.stop();
      io.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Enough data for the pages to have something in them: projects in groups, base domains with hostnames, API tokens. */
async function seed(): Promise<void> {
  const { createProject } = await import("../../src/modules/projects/operations");
  const { addManagedDomain, reserveHostnameForProject } = await import("../../src/modules/ingress/managedDomains");
  const { createApiToken } = await import("../../src/modules/identity/apiTokens");

  addManagedDomain("example.com", true);
  addManagedDomain("apps.example.org");
  const projects = [
    { name: "shop", groupName: "production" },
    { name: "shop-api", groupName: "production" },
    { name: "shop-staging", groupName: "staging" },
    { name: "blog", groupName: null },
  ];
  for (const input of projects) {
    const project = createProject({ ...input, sourceType: "upload" });
    try { reserveHostnameForProject(project.id, project.name); } catch { /* the page shows what it can */ }
  }
  createApiToken({ name: "laptop Claude Code", expiresInDays: 90, scope: "read" });
  createApiToken({ name: "ci deploy (production only)", expiresInDays: 30, scope: "write", projectGroup: "production" });
  createApiToken({ name: "old token", expiresInDays: null, scope: "write" });
}
