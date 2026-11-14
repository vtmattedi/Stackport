import crypto from "crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { PeerError } from "./errors";
import { parseGrants, serializeGrants, type Grant } from "./grants";
import { KEY_ROTATION_GRACE_MS, NONCE_RETENTION_MS, newKey, sha256Hex } from "./signing";

/** Persistence for both directions of a pairing. `db` defaults to the installation's database; tests pass a second one to play the other instance. */

export interface Controller {
  id: number;
  instanceId: string;
  name: string;
  grants: Grant[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Target {
  id: number;
  instanceId: string;
  name: string;
  endpoint: string;
  certFingerprint: string | null;
  grants: Grant[];
  protocol: number;
  createdAt: string;
  lastSeenAt: string | null;
}

interface ControllerRow { id: number; instance_id: string; name: string; grants: string; created_at: string; last_used_at: string | null; revoked_at: string | null; key_enc: string; previous_key_enc: string | null; previous_key_expires_at: string | null }
interface TargetRow { id: number; instance_id: string; name: string; endpoint: string; cert_fingerprint: string | null; key_enc: string; grants: string; protocol: number; created_at: string; last_seen_at: string | null }

export const PAIRING_CODE_MAX_TTL_MINUTES = 60;

const controllerOf = (row: ControllerRow): Controller => ({ id: row.id, instanceId: row.instance_id, name: row.name, grants: parseGrants(row.grants), createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });
const targetOf = (row: TargetRow): Target => ({ id: row.id, instanceId: row.instance_id, name: row.name, endpoint: row.endpoint, certFingerprint: row.cert_fingerprint, grants: parseGrants(row.grants), protocol: row.protocol, createdAt: row.created_at, lastSeenAt: row.last_seen_at });

// ── pairing codes (this instance is the one being controlled) ──────────────────

/** A single-use secret the admin hands to the controlling side. Only its hash is stored. */
export function createPairingSecret(grants: Grant[], ttlMinutes: number, db: Database.Database = getDatabase()): { secret: string; expiresAt: string } {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > PAIRING_CODE_MAX_TTL_MINUTES) throw new PeerError(400, `A pairing code lasts 1 to ${PAIRING_CODE_MAX_TTL_MINUTES} minutes.`, "bad-ttl");
  const secret = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare("DELETE FROM peer_pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(new Date().toISOString());
  db.prepare("INSERT INTO peer_pairing_codes (secret_hash, grants, expires_at) VALUES (?, ?, ?)").run(sha256Hex(secret), serializeGrants(grants), expiresAt);
  return { secret, expiresAt };
}

/** Spends the code: true for exactly one caller, and only while it is unexpired. */
export function consumePairingSecret(secret: string, db: Database.Database = getDatabase()): Grant[] | null {
  const now = new Date().toISOString();
  const hash = sha256Hex(secret);
  return db.transaction(() => {
    const row = db.prepare("SELECT id, grants FROM peer_pairing_codes WHERE secret_hash = ? AND used_at IS NULL AND expires_at > ?").get(hash, now) as { id: number; grants: string } | undefined;
    if (!row) return null;
    db.prepare("UPDATE peer_pairing_codes SET used_at = ? WHERE id = ?").run(now, row.id);
    return parseGrants(row.grants);
  }).immediate();
}

// ── controllers: who may control this instance ────────────────────────────────

/** Records (or re-pairs) a controller with a fresh key; the key is returned once and never readable again. */
export function upsertController(input: { instanceId: string; name: string; grants: Grant[] }, db: Database.Database = getDatabase()): { controller: Controller; key: string; previous: Controller | null } {
  const key = newKey();
  // One transaction, so two pairings from the same instance each record what they actually replaced.
  return db.transaction(() => {
    const previous = getControllerByInstance(input.instanceId, db);
    db.prepare(`
      INSERT INTO peer_controllers (instance_id, name, key_enc, grants) VALUES (?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET name = excluded.name, key_enc = excluded.key_enc, grants = excluded.grants,
        previous_key_enc = NULL, previous_key_expires_at = NULL, revoked_at = NULL, created_at = CURRENT_TIMESTAMP, last_used_at = NULL
    `).run(input.instanceId, input.name, encryptSecret(key), serializeGrants(input.grants));
    return { controller: getControllerByInstance(input.instanceId, db) as Controller, key, previous };
  }).immediate();
}

export function listControllers(db: Database.Database = getDatabase()): Controller[] {
  return (db.prepare("SELECT * FROM peer_controllers ORDER BY id").all() as ControllerRow[]).map(controllerOf);
}

export function getControllerByInstance(instanceId: string, db: Database.Database = getDatabase()): Controller | null {
  const row = db.prepare("SELECT * FROM peer_controllers WHERE instance_id = ?").get(instanceId) as ControllerRow | undefined;
  return row ? controllerOf(row) : null;
}

/** The keys a request from this controller may be signed with: the current one, and the previous one while its grace lasts. Includes revoked controllers so the caller can be told. */
export function controllerKeys(instanceId: string, db: Database.Database = getDatabase()): { controller: Controller; keys: string[] } | null {
  const row = db.prepare("SELECT * FROM peer_controllers WHERE instance_id = ?").get(instanceId) as ControllerRow | undefined;
  if (!row) return null;
  const keys = [decryptSecret(row.key_enc)];
  if (row.previous_key_enc && row.previous_key_expires_at && Date.parse(row.previous_key_expires_at) > Date.now()) keys.push(decryptSecret(row.previous_key_enc));
  return { controller: controllerOf(row), keys };
}

/** Written at most once a minute per controller, so a busy peer does not turn every request into a database write. */
export function touchController(id: number, db: Database.Database = getDatabase()): void {
  const now = Date.now();
  db.prepare("UPDATE peer_controllers SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").run(new Date(now).toISOString(), id, new Date(now - 60_000).toISOString());
}

/** The first request signed with the current key proves the controller holds it: the previous key is no longer needed. */
export function confirmControllerKey(id: number, db: Database.Database = getDatabase()): void {
  db.prepare("UPDATE peer_controllers SET previous_key_enc = NULL, previous_key_expires_at = NULL WHERE id = ? AND previous_key_enc IS NOT NULL").run(id);
}

export function revokeController(id: number, db: Database.Database = getDatabase()): boolean {
  return db.prepare("UPDATE peer_controllers SET revoked_at = ?, previous_key_enc = NULL, previous_key_expires_at = NULL WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id).changes > 0;
}

/** Switches to a key the controller chose. The controller generates it, so it is never lost in transit: if the answer is lost it
 *  repeats the same call, which is a no-op once the key is current. The old key keeps working until the new one is first used. */
export function rotateControllerKey(id: number, newKeyValue: string, db: Database.Database = getDatabase()): void {
  const row = db.prepare("SELECT key_enc FROM peer_controllers WHERE id = ? AND revoked_at IS NULL").get(id) as { key_enc: string } | undefined;
  if (!row) throw new Error("No such active controller.");
  if (decryptSecret(row.key_enc) === newKeyValue) return;
  db.prepare("UPDATE peer_controllers SET key_enc = ?, previous_key_enc = ?, previous_key_expires_at = ? WHERE id = ?")
    .run(encryptSecret(newKeyValue), row.key_enc, new Date(Date.now() + KEY_ROTATION_GRACE_MS).toISOString(), id);
}

let lastNoncePrune = 0;

/** A nonce is accepted once per controller. Returns false for a replay. */
export function recordNonce(controllerId: number, nonce: string, db: Database.Database = getDatabase()): boolean {
  const now = Date.now();
  if (now - lastNoncePrune > 60_000) {
    lastNoncePrune = now;
    db.prepare("DELETE FROM peer_nonces WHERE seen_at < ?").run(now - NONCE_RETENTION_MS);
  }
  return db.prepare("INSERT OR IGNORE INTO peer_nonces (controller_id, nonce, seen_at) VALUES (?, ?, ?)").run(controllerId, nonce, now).changes > 0;
}

// ── targets: instances this one controls ──────────────────────────────────────

export function addTarget(input: { instanceId: string; name: string; endpoint: string; certFingerprint: string | null; key: string; grants: Grant[]; protocol: number }, db: Database.Database = getDatabase()): Target {
  db.prepare(`
    INSERT INTO peer_targets (instance_id, name, endpoint, cert_fingerprint, key_enc, grants, protocol) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET name = excluded.name, endpoint = excluded.endpoint, cert_fingerprint = excluded.cert_fingerprint,
      key_enc = excluded.key_enc, grants = excluded.grants, protocol = excluded.protocol
  `).run(input.instanceId, input.name, input.endpoint, input.certFingerprint, encryptSecret(input.key), serializeGrants(input.grants), input.protocol);
  return getTargetByInstance(input.instanceId, db) as Target;
}

export function listTargets(db: Database.Database = getDatabase()): Target[] {
  return (db.prepare("SELECT * FROM peer_targets ORDER BY id").all() as TargetRow[]).map(targetOf);
}

export function getTarget(id: number, db: Database.Database = getDatabase()): Target | null {
  const row = db.prepare("SELECT * FROM peer_targets WHERE id = ?").get(id) as TargetRow | undefined;
  return row ? targetOf(row) : null;
}

export function getTargetByInstance(instanceId: string, db: Database.Database = getDatabase()): Target | null {
  const row = db.prepare("SELECT * FROM peer_targets WHERE instance_id = ?").get(instanceId) as TargetRow | undefined;
  return row ? targetOf(row) : null;
}

export function targetKey(id: number, db: Database.Database = getDatabase()): string | null {
  const row = db.prepare("SELECT key_enc FROM peer_targets WHERE id = ?").get(id) as { key_enc: string } | undefined;
  return row ? decryptSecret(row.key_enc) : null;
}

export function updateTarget(id: number, patch: { name?: string; grants?: Grant[]; protocol?: number; key?: string; endpoint?: string; seen?: boolean }, db: Database.Database = getDatabase()): void {
  db.prepare(`
    UPDATE peer_targets SET name = COALESCE(?, name), grants = COALESCE(?, grants), protocol = COALESCE(?, protocol),
      key_enc = COALESCE(?, key_enc), endpoint = COALESCE(?, endpoint), last_seen_at = COALESCE(?, last_seen_at) WHERE id = ?
  `).run(patch.name ?? null, patch.grants ? serializeGrants(patch.grants) : null, patch.protocol ?? null, patch.key ? encryptSecret(patch.key) : null, patch.endpoint ?? null, patch.seen ? new Date().toISOString() : null, id);
}

export function removeTarget(id: number, db: Database.Database = getDatabase()): boolean {
  return db.prepare("DELETE FROM peer_targets WHERE id = ?").run(id).changes > 0;
}
