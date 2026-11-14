import type { Migration } from "./index";

/** Stackport Control (1.4, docs/engineering/peer-control.md). Relationships are directional, so they live in two tables:
 *  `peer_targets` are the instances THIS one controls; `peer_controllers` are the instances allowed to control this one.
 *  Shared keys are stored encrypted with the installation keyring, like every other secret. */
const migration: Migration = {
  id: 21,
  name: "peers",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS peer_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        cert_fingerprint TEXT,
        key_enc TEXT NOT NULL,
        grants TEXT NOT NULL DEFAULT '',
        protocol INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS peer_controllers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        key_enc TEXT NOT NULL,
        previous_key_enc TEXT,
        previous_key_expires_at TEXT,
        grants TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS peer_pairing_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        secret_hash TEXT NOT NULL UNIQUE,
        grants TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS peer_nonces (
        controller_id INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (controller_id, nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_peer_nonces_seen_at ON peer_nonces (seen_at);
    `);
  },
};

export default migration;
