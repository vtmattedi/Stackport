import type { Migration } from "./index";

/** Full backups made from the dashboard: one job per backup, and the projects it has stopped for copying (so a restart in the middle gives them back).
 *  Runtime state, never part of a backup. */
const migration: Migration = {
  id: 25,
  name: "full_backups",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS full_backups (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        quiesced_json TEXT NOT NULL DEFAULT '{}',
        file TEXT,
        size INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

export default migration;
