import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Which projects a `write` token may act on (S5): NULL means every project, a name means
 *  only the projects in that project group. Read tokens ignore it. */
const migration: Migration = {
  id: 10,
  name: "api_token_project_group",
  up(db) {
    if (!hasColumn(db, "api_tokens", "project_group")) {
      db.exec("ALTER TABLE api_tokens ADD COLUMN project_group TEXT");
    }
  },
};

export default migration;
