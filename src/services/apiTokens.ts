import crypto from "crypto";
import { getDatabase } from "../config/database";

/** Scopes a token can carry. Only `read` exists for now; the check is in place so write
 *  scopes can be added without changing stored tokens. */
export const API_TOKEN_SCOPES = ["read"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

const TOKEN_PREFIX = "spk_";
const MAX_NAME_LENGTH = 80;
/** last_used_at is written at most this often per token, not on every request. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface ApiToken {
  id: number;
  name: string;
  /** The first characters of the token, so the admin can tell tokens apart. */
  prefix: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface ApiTokenRow {
  id: number;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export class ApiTokenError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseScopes(raw: string): ApiTokenScope[] {
  return raw.split(",").filter((s): s is ApiTokenScope => (API_TOKEN_SCOPES as readonly string[]).includes(s));
}

function rowToToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createApiToken(input: { name: unknown; expiresInDays?: unknown }): { token: string; record: ApiToken } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new ApiTokenError(400, `name is required and at most ${MAX_NAME_LENGTH} characters`);
  }
  let expiresAt: string | null = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const days = input.expiresInDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
      throw new ApiTokenError(400, "expiresInDays must be a whole number of days from 1 to 3650, or null for no expiry");
    }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const db = getDatabase();
  const result = db.prepare(
    "INSERT INTO api_tokens (name, token_hash, prefix, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(name, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 6), "read", new Date().toISOString(), expiresAt);
  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(result.lastInsertRowid) as ApiTokenRow;
  return { token, record: rowToToken(row) };
}

export function listApiTokens(): ApiToken[] {
  const rows = getDatabase().prepare("SELECT * FROM api_tokens ORDER BY id DESC").all() as ApiTokenRow[];
  return rows.map(rowToToken);
}

/** Revoked tokens stay listed (with revokedAt) so the admin can see what existed. */
export function revokeApiToken(id: number): boolean {
  const result = getDatabase()
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

/** The token's record when it is valid (known, not revoked, not expired) and carries
 *  `scope`; otherwise null. Lookup is by hash, so the raw token is never compared. */
export function verifyApiToken(raw: string, scope: ApiTokenScope): ApiToken | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hashToken(raw)) as ApiTokenRow | undefined;
  if (!row || row.revoked_at) return null;
  const now = Date.now();
  if (row.expires_at && Date.parse(row.expires_at) <= now) return null;
  const record = rowToToken(row);
  if (!record.scopes.includes(scope)) return null;

  if (!row.last_used_at || now - Date.parse(row.last_used_at) > LAST_USED_WRITE_INTERVAL_MS) {
    db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
  }
  return record;
}
