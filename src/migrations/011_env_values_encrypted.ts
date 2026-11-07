import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Managed env values, encrypted (S13). `variables_json` stays for rows written before
 *  this and as '[]' on new ones, so the schema only grows. */
const migration: Migration = {
  id: 11,
  name: "env_values_encrypted",
  up(db) {
    if (!hasColumn(db, "project_env_files", "variables_enc")) {
      db.exec("ALTER TABLE project_env_files ADD COLUMN variables_enc TEXT");
    }
  },
};

export default migration;
