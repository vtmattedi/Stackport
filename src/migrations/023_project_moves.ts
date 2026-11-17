import type { Migration } from "./index";

/** Moving a project between instances (docs/engineering/peer-control.md). Three roles, three tables, all runtime state that a backup never carries:
 *  the target's import tickets, the source's move (with its lease and the state to go back to), and the controller's own record of the operation. */
const migration: Migration = {
  id: 23,
  name: "project_moves",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_transfers_in (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        key_enc TEXT NOT NULL,
        controller_instance TEXT NOT NULL,
        state TEXT NOT NULL,
        name TEXT NOT NULL,
        domains_json TEXT NOT NULL DEFAULT '[]',
        received_bytes INTEGER NOT NULL DEFAULT 0,
        next_chunk INTEGER NOT NULL DEFAULT 0,
        last_chunk_sha TEXT,
        size INTEGER,
        sha256 TEXT,
        digest TEXT,
        project_id INTEGER,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_moves_out (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        controller_instance TEXT NOT NULL,
        state TEXT NOT NULL,
        original_json TEXT NOT NULL,
        digest TEXT,
        sent_bytes INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_moves_out_project ON project_moves_out (project_id, state);
      CREATE TABLE IF NOT EXISTS peer_moves (
        id TEXT PRIMARY KEY,
        source_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        project_name TEXT NOT NULL,
        state TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

export default migration;
