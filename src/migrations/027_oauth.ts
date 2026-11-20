import type { Migration } from "./index";

/** OAuth for the MCP endpoint (modules/identity/oauth). Clients register themselves (RFC 7591); the admin approves each one on the
 *  consent page and picks its scopes. What a client ends up holding is an ordinary short-lived API token (api_tokens, marked with
 *  oauth_client_id) plus a refresh token kept here. Only hashes of codes and refresh tokens are stored. */
const migration: Migration = {
  id: 27,
  name: "oauth",
  up(db) {
    const columns = new Set((db.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]).map((column) => column.name));
    if (!columns.has("oauth_client_id")) db.exec("ALTER TABLE api_tokens ADD COLUMN oauth_client_id TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        info TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        state TEXT,
        resource TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        project_group TEXT,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        project_group TEXT,
        access_token_id INTEGER,
        family TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        rotated_at TEXT
      );
    `);
  },
};

export default migration;
