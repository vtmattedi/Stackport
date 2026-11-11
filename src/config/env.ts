import dotenv from "dotenv";

dotenv.config({ quiet: true });

/** A positive number from the environment, or the fallback when unset or invalid. */
function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function require_env(key: string): string {
  // eslint-disable-next-line security/detect-object-injection -- the key is a variable name chosen in code.
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3000", 10),
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  jwtSecret: require_env("JWT_SECRET"),
  // Key for stored secrets, separate from the session secret (utils/crypto.ts). Optional so an
  // install keeps working until stackport.sh has generated one.
  encryptionKey: process.env["ENCRYPTION_KEY"] ?? "",
  // Signs the reboot requests Host > Power writes for the host (maintenance/power.ts); stackport.sh generates it. Empty disables Power.
  powerKey: process.env["STACKPORT_POWER_KEY"] ?? "",
  encryptionKeysPrevious: (process.env["ENCRYPTION_KEY_PREVIOUS"] ?? "").split(",").map((key) => key.trim()).filter(Boolean),
  // A session ends after this long without use, and in any case this long after login (S6).
  sessionIdleHours: positiveNumber(process.env["SESSION_IDLE_HOURS"], 24),
  sessionMaxHours: positiveNumber(process.env["SESSION_MAX_HOURS"], 12),
  // Legacy override only (Phase 1.9) — installs no longer set these. The source of
  // truth is app_meta (admin_username/admin_password_hash), generated through the
  // one-time bootstrap flow (modules/identity/installation.ts). Kept optional so an install
  // that predates the bootstrap flow (this dev host included) keeps working — see
  // installation.ts's isInitialized(), which treats "both set via env" as already
  // initialized rather than forcing a new bootstrap.
  adminUsername: process.env["ADMIN_USERNAME"] ?? null,
  adminPasswordHash: process.env["ADMIN_PASSWORD_HASH"] ?? null,
  webhookSecret: require_env("WEBHOOK_SECRET"),
  // Webhook-triggered scripts are opt-in functionality — defaults to a subpath of
  // the already-persisted data mount so it's never a hard requirement to boot.
  scriptsDir: process.env["SCRIPTS_DIR"] ?? "./data/scripts",
  // Phase 1.9 bootstrap — StackPort's own public domain/ACME email, set once by
  // stackport.sh into stackport.env. Blank domain means a raw-IP install; see
  // modules/ingress/bootstrap.ts for how that's resolved into a self-signed cert instead
  // of a Let's Encrypt one.
  /** Where isolated projects' networks get their subnets (P7), one /27 each. Must not overlap anything on the host. */
  isolationRange: process.env["STACKPORT_ISOLATION_RANGE"] ?? "10.212.0.0/14",
  /** GitHub's API and web origins. Environment only, never a setting: a user cannot point Stackport at a server of their choosing. */
  githubApiUrl: (process.env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, ""),
  githubWebUrl: (process.env["GITHUB_WEB_URL"] ?? "https://github.com").replace(/\/+$/, ""),
  stackportDomain: process.env["STACKPORT_DOMAIN"] ?? "",
  certbotEmail: process.env["CERTBOT_EMAIL"] ?? "",
  allowedOrigins: (process.env["ALLOWED_ORIGINS"] ?? "").split(",").filter(Boolean),
  logLevel: process.env["LOG_LEVEL"] ?? "info",
  logDir: process.env["LOG_DIR"] ?? "./logs",
  sqlitePath: process.env["SQLITE_PATH"] ?? "./data/stackport.sqlite",
  deployRoot: process.env["DEPLOY_ROOT"] ?? "./data/repos",
  nginxPath: process.env["NGINX_PATH"] ?? "/etc/nginx",
  // The reverse proxy that is allowed to set X-Forwarded-For (modules/ingress/trustedProxy.ts).
  trustedProxyHost: process.env["TRUSTED_PROXY_HOST"] ?? "stackport-nginx",
  appServiceName: process.env["APP_SERVICE_NAME"] ?? "stackport",
  // Real host checkout path used by Docker Compose to resolve system mounts.
  hostProjectRoot: process.env["HOST_PROJECT_ROOT"] ?? process.cwd(),
  // The data directory as the host sees it (written by stackport.sh). Managed mount
  // directories are created below it, and Docker needs their host path.
  hostDataDir: process.env["STACKPORT_DATA_DIR"] ?? "",
  // Read-only host mounts (docker-compose.system.yml) for host metrics. Each reader
  // falls back to what the container itself sees when its mount is missing.
  hostSysPath: process.env["HOST_SYS_PATH"] ?? "/host/sys",
  hostDockerRootPath: process.env["HOST_DOCKER_ROOT_PATH"] ?? "/host/docker-root",
  hostHostnamePath: process.env["HOST_HOSTNAME_PATH"] ?? "/host/etc/hostname",
} as const;
