import type { Migration } from "./index";

/** Where each project's mount data was copied from when it moved to a Stackport-owned
 *  directory (S2), so the originals can be removed later from Settings > Migrations.
 *  Only that temporary feature reads it; the table is harmless once it is gone. */
const migration: Migration = {
  id: 10,
  name: "legacy_mount_sources",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS legacy_mount_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        managed_name TEXT NOT NULL,
        copied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        removed_at TEXT,
        UNIQUE (project_id, source_path)
      );
    `);
  },
};

export default migration;
