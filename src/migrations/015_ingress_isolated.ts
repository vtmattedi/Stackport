import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Whether a project's routed services sit on a network of their own (P7) instead of the shared ingress
 *  network. Off for every project, new and existing: an admin switches one over, and can switch it back. */
const migration: Migration = {
  id: 15,
  name: "ingress_isolated",
  up(db) {
    if (!hasColumn(db, "projects", "ingress_isolated")) {
      db.exec("ALTER TABLE projects ADD COLUMN ingress_isolated INTEGER NOT NULL DEFAULT 0");
    }
  },
};

export default migration;
