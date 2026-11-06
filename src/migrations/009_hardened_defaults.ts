import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Whether a project's services get Stackport's hardened defaults (S8): no-new-privileges
 *  and a default memory and process limit. New projects start with them on; existing
 *  projects stay as they are until an admin turns them on, because a memory limit can
 *  stop a service that has been running without one. */
const migration: Migration = {
  id: 9,
  name: "hardened_defaults",
  up(db) {
    if (!hasColumn(db, "projects", "hardened_defaults")) {
      db.exec("ALTER TABLE projects ADD COLUMN hardened_defaults INTEGER NOT NULL DEFAULT 1");
      db.exec("UPDATE projects SET hardened_defaults = 0");
    }
  },
};

export default migration;
