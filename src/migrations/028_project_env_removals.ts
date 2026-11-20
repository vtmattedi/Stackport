import type { Migration } from "./index";

const migration: Migration = {
  id: 28,
  name: "project env removals",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_env_removals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        fingerprint TEXT,
        UNIQUE (project_id, relative_path)
      );
    `);
  },
};

export default migration;
