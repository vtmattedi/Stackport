import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Network groups: projects in the same group can reach each other's chosen services over a
 *  network Stackport creates for the group. Separate from `group_name`, which only groups the
 *  project list and scopes MCP tokens. Nothing joins a group until an admin picks services. */
const migration: Migration = {
  id: 14,
  name: "network_groups",
  up(db) {
    if (!hasColumn(db, "projects", "network_group")) {
      db.exec("ALTER TABLE projects ADD COLUMN network_group TEXT");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS network_group_services (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        PRIMARY KEY (project_id, service)
      )
    `);
  },
};

export default migration;
