import { config } from "../../config/env";
import { getDatabase } from "../../config/database";
import { DOMAIN_RE } from "../domainName";

const APP_NGINX_ENABLED_KEY = "nginx_app_enabled";

const APP_NGINX_DOMAIN_KEY = "nginx_app_domain";

const APP_NGINX_USE_SSL_KEY = "nginx_app_use_ssl";

export interface NginxAppConfig {
  enabled: boolean;
  domain: string;
  port: number;
  useSsl: boolean;
}

export function getNginxAppConfig(): NginxAppConfig {
  const rows = getDatabase()
    .prepare("SELECT key, value FROM app_meta WHERE key IN (?, ?, ?)")
    .all(APP_NGINX_ENABLED_KEY, APP_NGINX_DOMAIN_KEY, APP_NGINX_USE_SSL_KEY) as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    enabled: values.get(APP_NGINX_ENABLED_KEY) === "1",
    domain: values.get(APP_NGINX_DOMAIN_KEY) ?? "",
    port: config.port,
    useSsl: values.get(APP_NGINX_USE_SSL_KEY) !== "0",
  };
}

export function setNginxAppConfig(input: { enabled: boolean; domain: string; useSsl?: boolean }): NginxAppConfig {
  const domain = input.domain.trim().toLowerCase();
  if (input.enabled && !DOMAIN_RE.test(domain)) {
    throw new Error("domain must be a valid hostname before enabling app Nginx publishing");
  }

  const db = getDatabase();
  if (input.enabled) {
    const portConflict = db.prepare("SELECT name FROM projects WHERE internal_port = ? LIMIT 1").get(config.port) as { name: string } | undefined;
    if (portConflict) {
      throw new Error(`Cannot enable app Nginx publishing because project "${portConflict.name}" already uses backend port ${config.port}`);
    }
    const domainConflict = db.prepare(
      "SELECT p.name AS name FROM project_domains pd JOIN projects p ON p.id = pd.project_id WHERE lower(pd.domain) = lower(?) LIMIT 1"
    ).get(domain) as { name: string } | undefined;
    if (domainConflict) {
      throw new Error(`Cannot enable app Nginx publishing because project "${domainConflict.name}" already uses ${domain}`);
    }
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsert.run(APP_NGINX_ENABLED_KEY, input.enabled ? "1" : "0", now);
  upsert.run(APP_NGINX_DOMAIN_KEY, domain, now);
  upsert.run(APP_NGINX_USE_SSL_KEY, input.useSsl === false ? "0" : "1", now);

  return getNginxAppConfig();
}
