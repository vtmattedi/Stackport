import type { Migration } from "./index";

/** Stackport Control: what a controller's write requests did, keyed by its operation id, so a repeated request (a retry after a lost answer)
 *  returns the first result instead of acting twice. Runtime state: never part of a backup, and pruned after a week. */
const migration: Migration = {
  id: 22,
  name: "peer_operations",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS peer_operations (
        controller_id INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status INTEGER,
        body TEXT,
        content_type TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (controller_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_peer_operations_created_at ON peer_operations (created_at);
    `);
  },
};

export default migration;
