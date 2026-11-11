import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** The domain manager (1.3.7): the base domains Stackport manages, and for each project hostname which base domain and
 *  label it was made from. `project_domains.domain` stays the full hostname, so nginx, Certbot and the health checker are
 *  unchanged; a row with no `managed_domain_id` is unmanaged. Additive only.
 *  `managed_domains.dns_*` belong to the DNS check, which was removed before release: they are created and never used. */
const migration: Migration = {
  id: 18,
  name: "managed_domains",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS managed_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0,
        dns_status TEXT NOT NULL DEFAULT 'unknown',
        dns_checked_at TEXT,
        dns_detail TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_domains_one_default ON managed_domains (is_default) WHERE is_default = 1;
    `);
    // `redirect_apex`: this is a `www.` hostname and the bare domain redirects to it (www is the canonical name).
    for (const [column, type] of [["managed_domain_id", "INTEGER"], ["label", "TEXT"], ["redirect_apex", "INTEGER NOT NULL DEFAULT 0"]] as const) {
      if (!hasColumn(db, "project_domains", column)) db.exec(`ALTER TABLE project_domains ADD COLUMN ${column} ${type}`);
    }
  },
};

export default migration;
