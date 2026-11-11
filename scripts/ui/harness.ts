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

  // A page load is about 11 API requests and a screenshot run loads many pages from one address, so the global limit would answer 429 part way.
  const { globalLimiter } = await import("../../src/application/http/rateLimiter");
  const resetLimit = setInterval(() => { for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) void globalLimiter.resetKey(ip); }, 1000);
  resetLimit.unref();

  const http: Server = createServer(app);
  const io = new SocketIOServer(http);
  const sockets = new SocketManager(io);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      clearInterval(resetLimit);
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
  const github = await import("../../src/modules/github/store");

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
  // UI_HARNESS_GITHUB=none leaves the App unregistered, which is what Settings > GitHub shows on a fresh server.
  if (process.env["UI_HARNESS_GITHUB"] !== "none") seedGithubApp(github);
}

/** A registered GitHub App with one connected account and a list of repositories, so Settings > GitHub and the new-project
 *  wizard's repository list have something in them. Nothing here talks to github.com. */
function seedGithubApp(github: typeof import("../../src/modules/github/store")): void {
  github.saveApp(
    { appId: 4242, slug: "stackport-ui-harness", name: "Stackport ui.example.com", clientId: "Iv1.harness", ownerLogin: "ui-harness", ownerType: "User", isPublic: false, htmlUrl: "https://github.com/apps/stackport-ui-harness", registeredOrigin: "https://ui.example.com", modules: ["deployments", "ci", "releases"] },
    { privateKey: "harness-not-a-key", webhookSecret: "harness-webhook-secret", clientSecret: "harness-client-secret" },
  );
  github.upsertInstallation({ installationId: 9001, accountId: 1, accountLogin: "ui-harness", accountType: "User", permissions: { contents: "read", metadata: "read" }, suspended: false }, true);
  github.upsertInstallation({ installationId: 9002, accountId: 2, accountLogin: "acme-co", accountType: "Organization", permissions: { contents: "read", metadata: "read" }, suspended: false }, true);
  const names: [string, string, boolean, boolean][] = [
    ["ui-harness/shop", "main", true, false], ["ui-harness/shop-api", "main", true, false], ["ui-harness/blog", "main", false, false],
    ["ui-harness/dotfiles", "master", false, false], ["ui-harness/old-experiment", "main", false, true], ["ui-harness/notes", "main", true, false],
    ["acme-co/web", "main", true, false], ["acme-co/api", "develop", true, false], ["acme-co/infra", "main", true, false], ["acme-co/docs", "main", false, false],
  ];
  const repos = (installationId: number, prefix: string): import("../../src/modules/github/store").RepositoryRecord[] => names
    .filter(([name]) => name.startsWith(prefix))
    .map(([fullName, defaultBranch, isPrivate, archived], index) => ({ repositoryId: installationId * 100 + index, installationId, fullName, defaultBranch, isPrivate, archived }));
  github.replaceRepositories(9001, repos(9001, "ui-harness/"));
  github.replaceRepositories(9002, repos(9002, "acme-co/"));
}
