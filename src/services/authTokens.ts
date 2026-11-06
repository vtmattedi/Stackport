import crypto from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { getDatabase } from "../config/database";
import { config } from "../config/env";

type StoredAuthTokenRow = {
  id: string;
  username: string;
  expires_at: string;
  created_at: string;
};

export type VerifiedAuthToken = {
  username: string;
  tokenId: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function tokenExpiryIso(token: string): string {
  const decoded = jwt.decode(token) as JwtPayload | null;
  if (typeof decoded?.exp !== "number") {
    throw new Error("Signed auth token is missing exp");
  }
  return new Date(decoded.exp * 1000).toISOString();
}

const HOUR_MS = 3_600_000;

/** A session's two limits (S6): it slides forward while in use, but never past a fixed
 *  time after login. */
export function sessionWindow(createdAtMs: number, nowMs: number): { expiresAtMs: number; capMs: number } {
  const capMs = createdAtMs + config.sessionMaxHours * HOUR_MS;
  return { expiresAtMs: Math.min(nowMs + config.sessionIdleHours * HOUR_MS, capMs), capMs };
}

/** SQLite's own default timestamps have no zone and a space instead of the T. */
function parseStoredTime(value: string): number {
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

function signAuthToken(username: string, tokenId: string, expiresAtMs: number): string {
  return jwt.sign({ sub: username }, config.jwtSecret, {
    expiresIn: Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000)),
    jwtid: tokenId,
  });
}

export function pruneExpiredAuthTokens(): void {
  getDatabase()
    .prepare("DELETE FROM auth_tokens WHERE expires_at <= ?")
    .run(nowIso());
}

export function issueAuthToken(username: string): string {
  pruneExpiredAuthTokens();

  const tokenId = crypto.randomUUID();
  const token = signAuthToken(username, tokenId, sessionWindow(Date.now(), Date.now()).expiresAtMs);
  const now = nowIso();

  getDatabase()
    .prepare(
      `INSERT INTO auth_tokens (id, username, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(tokenId, username, now, tokenExpiryIso(token), now);

  return token;
}

/** Slides the session forward, but not past its cap. Throws when the session is gone or
 *  has reached its cap (and deletes it then). */
export function refreshAuthToken(username: string, tokenId: string): string {
  const stored = getDatabase().prepare("SELECT created_at FROM auth_tokens WHERE id = ? AND username = ?").get(tokenId, username) as { created_at: string } | undefined;
  if (!stored) throw new Error("Auth token is no longer stored");
  const { expiresAtMs, capMs } = sessionWindow(parseStoredTime(stored.created_at), Date.now());
  if (capMs <= Date.now()) {
    invalidateAuthToken(tokenId);
    throw new Error("Session reached its maximum lifetime");
  }
  const token = signAuthToken(username, tokenId, expiresAtMs);
  const now = nowIso();

  const result = getDatabase()
    .prepare(
      `UPDATE auth_tokens
       SET expires_at = ?, last_seen_at = ?
       WHERE id = ? AND username = ?`
    )
    .run(tokenExpiryIso(token), now, tokenId, username);

  if (result.changes === 0) {
    throw new Error("Auth token is no longer stored");
  }

  return token;
}

export function verifyStoredAuthToken(token: string): VerifiedAuthToken | null {
  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }

  if (typeof decoded === "string" || typeof decoded.sub !== "string" || typeof decoded.jti !== "string") {
    return null;
  }

  const now = nowIso();
  const row = getDatabase()
    .prepare("SELECT id, username, expires_at, created_at FROM auth_tokens WHERE id = ?")
    .get(decoded.jti) as StoredAuthTokenRow | undefined;

  if (!row || row.username !== decoded.sub || row.expires_at <= now) {
    return null;
  }
  if (sessionWindow(parseStoredTime(row.created_at), Date.now()).capMs <= Date.now()) {
    invalidateAuthToken(row.id);
    return null;
  }

  getDatabase()
    .prepare("UPDATE auth_tokens SET last_seen_at = ? WHERE id = ?")
    .run(now, row.id);

  return {
    username: row.username,
    tokenId: row.id,
  };
}

export function invalidateAuthTokens(username?: string): number {
  const result = username
    ? getDatabase().prepare("DELETE FROM auth_tokens WHERE username = ?").run(username)
    : getDatabase().prepare("DELETE FROM auth_tokens").run();

  return result.changes;
}

export function invalidateAuthToken(tokenId: string): number {
  const result = getDatabase()
    .prepare("DELETE FROM auth_tokens WHERE id = ?")
    .run(tokenId);

  return result.changes;
}
