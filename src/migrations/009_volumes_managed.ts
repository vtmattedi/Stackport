import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Whether a project's writable mounts live in Stackport-owned directories (S2). New
 *  projects start managed. Projects that already exist keep their current mounts until
 *  Settings > Migrations copies their data and switches them over, so an update never
 *  points a running project at an empty directory. */
const migration: Migration = {
  id: 9,
  name: "volumes_managed",
  up(db) {
    if (!hasColumn(db, "projects", "volumes_managed")) {
      db.exec("ALTER TABLE projects ADD COLUMN volumes_managed INTEGER NOT NULL DEFAULT 1");
      db.exec("UPDATE projects SET volumes_managed = 0");
    }
  },
};

export default migration;
