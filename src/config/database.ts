import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./env";

let db: Database.Database | null = null;

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
}

export function initializeDatabase(): Database.Database {
  if (db) {
    return db;
  }

  ensureDatabaseDirectory(config.sqlitePath);
  db = new Database(config.sqlitePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_auth_tokens_username
      ON auth_tokens (username);

    CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at
      ON auth_tokens (expires_at);

    -- Phase 1.9 — one-time bootstrap and admin-recovery credentials (routes/setup.ts).
    -- 'bootstrap' is generated once at first boot (services/installation.ts) and
    -- consumed when the operator creates their real superadmin; 'recovery' is
    -- generated on demand by the host CLI's admin-recovery command (cli/adminRecovery.ts).
    -- Only one unconsumed/unexpired row per kind is meant to exist at a time —
    -- creating a new one invalidates any prior unconsumed row of the same kind.
    CREATE TABLE IF NOT EXISTS setup_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'recovery')),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_setup_credentials_kind
      ON setup_credentials (kind, consumed_at, expires_at);

    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'webhook',
      alias TEXT UNIQUE NOT NULL,
      username TEXT,
      header_name TEXT,
      secret_enc TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      script_path TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT,
      internal_port INTEGER,
      health_check_url TEXT,
      health_check_endpoint TEXT,
      health_check_interval_s INTEGER NOT NULL DEFAULT 0,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_response_ms INTEGER,
      last_checked_at TEXT,
      github_repo TEXT,
      credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
      github_credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_env_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      variables_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_env_files_project_path
      ON project_env_files (project_id, relative_path);

    CREATE TABLE IF NOT EXISTS project_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      domain TEXT NOT NULL COLLATE NOCASE,
      use_ssl INTEGER NOT NULL DEFAULT 0,
      service TEXT NOT NULL DEFAULT '',
      container_port INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_domains_domain
      ON project_domains (domain);

    CREATE INDEX IF NOT EXISTS idx_project_domains_project_id
      ON project_domains (project_id);

    -- Phase 1.7 — one row per deploy attempt. 'active' is the currently-running
    -- revision (at most one per project); a new successful deploy flips the previous
    -- 'active' row to 'superseded' and inserts a new 'active' row. Failed/rejected
    -- attempts (invalid compose, policy violation, storage guard) insert a 'failed'
    -- row without touching the active revision — see stackport_yml.md §12-13.
    CREATE TABLE IF NOT EXISTS project_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      commit_sha TEXT,
      branch TEXT,
      compose_file_name TEXT,
      source_compose TEXT,
      effective_compose TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'failed', 'superseded')),
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      blocked_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_project_deployments_project_id
      ON project_deployments (project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS vps_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vps_monitored_vms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL REFERENCES vps_providers(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_id, vm_id)
    );

    CREATE TABLE IF NOT EXISTS vps_vm_cache (
      provider_id INTEGER NOT NULL REFERENCES vps_providers(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY(provider_id, vm_id)
    );

    CREATE TABLE IF NOT EXISTS firewall_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL REFERENCES vps_providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      remote_firewall_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS firewall_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES firewall_profiles(id) ON DELETE CASCADE,
      action TEXT NOT NULL DEFAULT 'accept',
      protocol TEXT NOT NULL,
      port TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'any',
      source_detail TEXT NOT NULL DEFAULT 'any',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notification_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT 'resend',
      credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
      from_address TEXT NOT NULL DEFAULT '',
      to_address TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS github_poller_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      token_enc TEXT,
      poll_interval_s INTEGER NOT NULL DEFAULT 300,
      last_polled_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      commit_sha TEXT,
      commit_message TEXT,
      commit_author TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS hardware_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cpu_percent REAL NOT NULL,
      mem_percent REAL NOT NULL,
      mem_used_mb REAL NOT NULL,
      mem_total_mb REAL NOT NULL,
      load1 REAL NOT NULL,
      sampled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_hardware_samples_sampled_at
      ON hardware_samples (sampled_at);

    CREATE TABLE IF NOT EXISTS project_resource_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cpu_percent REAL NOT NULL,
      mem_used_mb REAL NOT NULL,
      mem_limit_mb REAL NOT NULL,
      mem_percent REAL NOT NULL,
      sampled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_project_resource_samples_project_sampled_at
      ON project_resource_samples (project_id, sampled_at);

    CREATE TABLE IF NOT EXISTS project_folder_size_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      size_bytes INTEGER NOT NULL,
      sampled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_project_folder_size_samples_project_sampled_at
      ON project_folder_size_samples (project_id, sampled_at);

    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL DEFAULT 'health_check',
      recipient TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT,
      project_name TEXT,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations for databases that predate new columns
  const webhookCols = db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[];
  if (!webhookCols.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE webhooks ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (!webhookCols.some((c) => c.name === "credential_id")) {
    db.exec("ALTER TABLE webhooks ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL");
  }

  const credentialCols = db.prepare("PRAGMA table_info(credentials)").all() as { name: string }[];
  if (!credentialCols.some((c) => c.name === "type")) {
    db.exec("ALTER TABLE credentials ADD COLUMN type TEXT NOT NULL DEFAULT 'webhook'");
  }
  if (!credentialCols.some((c) => c.name === "username")) {
    db.exec("ALTER TABLE credentials ADD COLUMN username TEXT");
  }
  if (!credentialCols.some((c) => c.name === "header_name")) {
    db.exec("ALTER TABLE credentials ADD COLUMN header_name TEXT");
  }
  if (!credentialCols.some((c) => c.name === "is_default")) {
    db.exec("ALTER TABLE credentials ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    UPDATE credentials
    SET is_default = 0
    WHERE type = 'github'
      AND is_default = 1
      AND id NOT IN (
        SELECT id FROM credentials
        WHERE type = 'github' AND is_default = 1
        ORDER BY id ASC
        LIMIT 1
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_one_default_github
      ON credentials (is_default)
      WHERE type = 'github' AND is_default = 1;
  `);

  const vpsProviderCols = db.prepare("PRAGMA table_info(vps_providers)").all() as { name: string }[];
  if (!vpsProviderCols.some((c) => c.name === "credential_id")) {
    db.exec("ALTER TABLE vps_providers ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL");
  }
  if (vpsProviderCols.some((c) => c.name === "api_key_enc")) {
    db.exec("ALTER TABLE vps_providers DROP COLUMN api_key_enc");
  }

  const notificationCols = db.prepare("PRAGMA table_info(notification_config)").all() as { name: string }[];
  if (!notificationCols.some((c) => c.name === "credential_id")) {
    db.exec("ALTER TABLE notification_config ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL");
  }
  if (notificationCols.some((c) => c.name === "api_key_enc")) {
    db.exec("ALTER TABLE notification_config DROP COLUMN api_key_enc");
  }

  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectCols.some((c) => c.name === "group_name")) {
    db.exec("ALTER TABLE projects ADD COLUMN group_name TEXT");
  }
  if (!projectCols.some((c) => c.name === "github_repo")) {
    db.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT");
  }
  if (!projectCols.some((c) => c.name === "credential_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL");
  }
  if (!projectCols.some((c) => c.name === "github_credential_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN github_credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL");
  }
  if (!projectCols.some((c) => c.name === "paused")) {
    db.exec("ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
  }
  if (!projectCols.some((c) => c.name === "domain")) {
    db.exec("ALTER TABLE projects ADD COLUMN domain TEXT");
  }
  if (!projectCols.some((c) => c.name === "internal_port")) {
    db.exec("ALTER TABLE projects ADD COLUMN internal_port INTEGER");
    const rows = db.prepare("SELECT id, url FROM projects WHERE url IS NOT NULL").all() as { id: number; url: string }[];
    for (const row of rows) {
      const port = portFromUrl(row.url);
      if (port !== null) {
        db.prepare("UPDATE projects SET internal_port = ? WHERE id = ?").run(port, row.id);
      }
    }
  }
  if (!projectCols.some((c) => c.name === "health_check_endpoint")) {
    db.exec("ALTER TABLE projects ADD COLUMN health_check_endpoint TEXT");
    const rows = db.prepare("SELECT id, health_check_url FROM projects WHERE health_check_url IS NOT NULL").all() as {
      id: number;
      health_check_url: string;
    }[];
    for (const row of rows) {
      const endpoint = endpointFromUrl(row.health_check_url);
      if (endpoint !== null) {
        db.prepare("UPDATE projects SET health_check_endpoint = ? WHERE id = ?").run(endpoint, row.id);
      }
    }
  }
  if (!projectCols.some((c) => c.name === "auto_deploy_branch")) {
    db.exec("ALTER TABLE projects ADD COLUMN auto_deploy_branch TEXT");
  }
  if (!projectCols.some((c) => c.name === "last_commit_sha")) {
    db.exec("ALTER TABLE projects ADD COLUMN last_commit_sha TEXT");
  }
  if (!projectCols.some((c) => c.name === "last_commit_message")) {
    db.exec("ALTER TABLE projects ADD COLUMN last_commit_message TEXT");
  }
  if (!projectCols.some((c) => c.name === "last_commit_author")) {
    db.exec("ALTER TABLE projects ADD COLUMN last_commit_author TEXT");
  }
  if (!projectCols.some((c) => c.name === "last_commit_at")) {
    db.exec("ALTER TABLE projects ADD COLUMN last_commit_at TEXT");
  }
  if (!projectCols.some((c) => c.name === "branches_json")) {
    db.exec("ALTER TABLE projects ADD COLUMN branches_json TEXT");
  }
  if (!projectCols.some((c) => c.name === "source_type")) {
    db.exec("ALTER TABLE projects ADD COLUMN source_type TEXT NOT NULL DEFAULT 'github'");
  }
  if (!projectCols.some((c) => c.name === "use_ssl")) {
    db.exec("ALTER TABLE projects ADD COLUMN use_ssl INTEGER NOT NULL DEFAULT 0");
  }
  if (!projectCols.some((c) => c.name === "nginx_extra_config")) {
    db.exec("ALTER TABLE projects ADD COLUMN nginx_extra_config TEXT");
  }
  if (!projectCols.some((c) => c.name === "nginx_extra_blocks")) {
    db.exec("ALTER TABLE projects ADD COLUMN nginx_extra_blocks TEXT");
  }
  if (!projectCols.some((c) => c.name === "compose_file")) {
    db.exec("ALTER TABLE projects ADD COLUMN compose_file TEXT");
  }
  if (!projectCols.some((c) => c.name === "available_compose_files")) {
    db.exec("ALTER TABLE projects ADD COLUMN available_compose_files TEXT");
  }
  if (!projectCols.some((c) => c.name === "favorite")) {
    db.exec("ALTER TABLE projects ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
  }

  // One-time: seed project_domains from the legacy single projects.domain/use_ssl
  // columns, which stay in place (unused by application code from here on) rather
  // than being dropped. Gated by an app_meta flag, not a row-count check, since a
  // project legitimately having zero domains afterward is valid.
  const DOMAINS_SEEDED_KEY = "project_domains_seeded_from_legacy";
  const domainsSeeded = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(DOMAINS_SEEDED_KEY) as { value: string } | undefined;
  if (!domainsSeeded) {
    const legacyDomains = db.prepare(
      "SELECT id, domain, use_ssl FROM projects WHERE domain IS NOT NULL AND trim(domain) <> ''"
    ).all() as { id: number; domain: string; use_ssl: number }[];
    const insertDomain = db.prepare(
      "INSERT OR IGNORE INTO project_domains (project_id, domain, use_ssl, created_at, updated_at) VALUES (?, lower(trim(?)), ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
    );
    for (const row of legacyDomains) insertDomain.run(row.id, row.domain, row.use_ssl);
    db.prepare(
      "INSERT INTO app_meta (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).run(DOMAINS_SEEDED_KEY);
  }

  // Phase 1.7 — domain -> service -> container_port routing (replaces the single
  // projects.internal_port model). Existing rows default to an empty service, which
  // reads as "not yet migrated to the new routing model" everywhere this is consumed.
  const domainCols = db.prepare("PRAGMA table_info(project_domains)").all() as { name: string }[];
  if (!domainCols.some((c) => c.name === "service")) {
    db.exec("ALTER TABLE project_domains ADD COLUMN service TEXT NOT NULL DEFAULT ''");
  }
  if (!domainCols.some((c) => c.name === "container_port")) {
    db.exec("ALTER TABLE project_domains ADD COLUMN container_port INTEGER");
  }

  const resourceSampleCols = db.prepare("PRAGMA table_info(project_resource_samples)").all() as { name: string }[];
  if (!resourceSampleCols.some((c) => c.name === "net_rx_mb")) {
    db.exec("ALTER TABLE project_resource_samples ADD COLUMN net_rx_mb REAL");
  }
  if (!resourceSampleCols.some((c) => c.name === "net_tx_mb")) {
    db.exec("ALTER TABLE project_resource_samples ADD COLUMN net_tx_mb REAL");
  }

  const ghCols = db.prepare("PRAGMA table_info(github_poller_config)").all() as { name: string }[];
  if (!ghCols.some((c) => c.name === "credential_id")) {
    db.exec("ALTER TABLE github_poller_config ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL");
  }
  if (!ghCols.some((c) => c.name === "last_poll_output")) {
    db.exec("ALTER TABLE github_poller_config ADD COLUMN last_poll_output TEXT");
  }

  return db;
}

function portFromUrl(value: string): number | null {
  try {
    const parsed = new URL(value);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : NaN;
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function endpointFromUrl(value: string): string | null {
  if (value.startsWith("/")) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.pathname || "/"}${parsed.search}`;
  } catch {
    return null;
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database has not been initialized");
  }

  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}
