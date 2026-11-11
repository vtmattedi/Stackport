import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** The result of the last DNS check of each hostname (domain manager). Additive only.
 *  The DNS check was removed before release: these columns are created but nothing reads or writes them. They stay because
 *  migrations only add. */
const migration: Migration = {
  id: 19,
  name: "hostname_dns",
  up(db) {
    for (const [column, type] of [["dns_status", "TEXT NOT NULL DEFAULT 'unknown'"], ["dns_checked_at", "TEXT"], ["dns_detail", "TEXT"]] as const) {
      if (!hasColumn(db, "project_domains", column)) db.exec(`ALTER TABLE project_domains ADD COLUMN ${column} ${type}`);
    }
  },
};

export default migration;
