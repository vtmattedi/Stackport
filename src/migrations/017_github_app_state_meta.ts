import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** What was chosen when a GitHub round trip started (whether the App is public), carried with its single-use state so
 *  it can be recorded when GitHub calls back. Additive only. */
const migration: Migration = {
  id: 17,
  name: "github_app_state_meta",
  up(db) {
    if (!hasColumn(db, "github_app_states", "meta")) db.exec("ALTER TABLE github_app_states ADD COLUMN meta TEXT");
  },
};

export default migration;
