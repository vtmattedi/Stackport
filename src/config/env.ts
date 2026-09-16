import dotenv from "dotenv";

dotenv.config({ quiet: true });

function require_env(key: string): string {
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
  jwtExpiry: process.env["JWT_EXPIRY"] ?? "7d",
  // Legacy override only (Phase 1.9) — installs no longer set these. The source of
  // truth is app_meta (admin_username/admin_password_hash), generated through the
  // one-time bootstrap flow (services/installation.ts). Kept optional so an install
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
  // services/appIngress.ts for how that's resolved into a self-signed cert instead
  // of a Let's Encrypt one.
  stackportDomain: process.env["STACKPORT_DOMAIN"] ?? "",
  certbotEmail: process.env["CERTBOT_EMAIL"] ?? "",
  allowedOrigins: (process.env["ALLOWED_ORIGINS"] ?? "").split(",").filter(Boolean),
  logLevel: process.env["LOG_LEVEL"] ?? "info",
  logDir: process.env["LOG_DIR"] ?? "./logs",
  sqlitePath: process.env["SQLITE_PATH"] ?? "./data/stackport.sqlite",
  deployRoot: process.env["DEPLOY_ROOT"] ?? "./data/repos",
  hostingerApiKey: process.env["HOSTINGER_API_KEY"] ?? "",
  hostingerVmId: process.env["HOSTINGER_VM_ID"] ?? "",
  nginxPath: process.env["NGINX_PATH"] ?? "/etc/nginx",
  appServiceName: process.env["APP_SERVICE_NAME"] ?? "stackport",
  // Real host checkout path used by Docker Compose to resolve system mounts.
  hostProjectRoot: process.env["HOST_PROJECT_ROOT"] ?? process.cwd(),
} as const;
