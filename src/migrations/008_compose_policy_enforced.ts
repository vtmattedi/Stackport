import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Whether the resolved-config Compose allowlist (S1) rejects a deploy or only warns.
 *  New projects enforce it; projects that already exist keep deploying and see the
 *  would-be violations as warnings, so an update never breaks a running install. */
const migration: Migration = {
  id: 8,
  name: "compose_policy_enforced",
  up(db) {
    if (!hasColumn(db, "projects", "compose_policy_enforced")) {
      db.exec("ALTER TABLE projects ADD COLUMN compose_policy_enforced INTEGER NOT NULL DEFAULT 1");
      db.exec("UPDATE projects SET compose_policy_enforced = 0");
    }
  },
};

export default migration;
