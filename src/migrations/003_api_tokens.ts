import type { Migration } from "./index";

/** Bearer tokens for machine clients (the MCP endpoint, services/apiTokens.ts). Only
 *  a SHA-256 hash of each token is stored; the token itself is shown once. */
const migration: Migration = {
  id: 3,
  name: "api_tokens",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT 'read',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT
      );
    `);
  },
};

export default migration;
