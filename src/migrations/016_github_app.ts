import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** The GitHub App (1.3.7): the one App an instance registers, its installations, the repositories they expose, the
 *  webhook deliveries received, and the short-lived `state` values of the browser round trips. Additive only. */
const migration: Migration = {
  id: 16,
  name: "github_app",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_app (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        app_id INTEGER NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        client_id TEXT NOT NULL,
        owner_login TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0,
        html_url TEXT NOT NULL,
        registered_origin TEXT NOT NULL,
        modules_json TEXT NOT NULL DEFAULT '[]',
        private_key_enc TEXT NOT NULL,
        webhook_secret_enc TEXT NOT NULL,
        client_secret_enc TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS github_app_installations (
        installation_id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unlinked',
        permissions_json TEXT NOT NULL DEFAULT '{}',
        linked_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS github_app_repositories (
        repository_id INTEGER PRIMARY KEY,
        installation_id INTEGER NOT NULL,
        full_name TEXT NOT NULL,
        default_branch TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        access_status TEXT NOT NULL DEFAULT 'granted',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_github_app_repositories_installation ON github_app_repositories (installation_id);
      CREATE TABLE IF NOT EXISTS github_app_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        action TEXT,
        installation_id INTEGER,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        attempts INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_github_app_deliveries_status ON github_app_deliveries (status, received_at);
      CREATE TABLE IF NOT EXISTS github_app_states (
        state TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        username TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    for (const [column, type] of [["github_auth_mode", "TEXT"], ["github_repository_id", "INTEGER"], ["github_installation_id", "INTEGER"]] as const) {
      if (!hasColumn(db, "projects", column)) db.exec(`ALTER TABLE projects ADD COLUMN ${column} ${type}`);
    }
  },
};

export default migration;
