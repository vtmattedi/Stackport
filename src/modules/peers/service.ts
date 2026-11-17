import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { ensureInstanceIdentity } from "../backup/instance";
import { assertEndpoint, PeerIdentityError, PeerUnreachable, pairCall, signedCall } from "./client";
import { PeerError } from "./errors";
import { GrantError, normalizeGrants, parseGrants, type Grant } from "./grants";
import { auditLog } from "../../shared/logger";
import { newKey, PROTOCOL_NAME, PROTOCOL_VERSIONS } from "./signing";
import { addTarget, consumePairingSecret, createPairingSecret, getTarget, removeTarget, targetKey, updateTarget, upsertController, type Controller, type Target } from "./store";

/** Pairing and the lifecycle of a peer relationship. Directional: pairing makes the instance that
 *  presents the code a CONTROLLER of the instance that issued it, and nothing more. */

export { PeerError };

/** An endpoint the admin typed is input: a bad one is a 400, never a server error. */
function checkEndpoint(endpoint: string): void {
  try { assertEndpoint(endpoint); } catch (error) { throw new PeerError(400, (error as Error).message, "bad-endpoint"); }
}

// ── pairing code ───────────────────────────────────────────────────────────────

export interface PairingCode {
  /** What the admin copies to the controlling instance. */
  code: string;
  expiresAt: string;
  grants: Grant[];
}

interface CodePayload { v: 1; u: string; i: string; f?: string; s: string }
const CODE_PREFIX = "spp1.";

/** Issued on the instance that will BE controlled. `endpoint` is where the controller will reach it; `fingerprint` pins a self-signed certificate. */
export function issuePairingCode(input: { endpoint: string; fingerprint?: string | null; grants: unknown; ttlMinutes?: number }, db: Database.Database = getDatabase()): PairingCode {
  let grants: Grant[];
  try { grants = normalizeGrants(input.grants); } catch (error) {
    if (error instanceof GrantError) throw new PeerError(400, error.message, "bad-grants");
    throw error;
  }
  checkEndpoint(input.endpoint);
  const { secret, expiresAt } = createPairingSecret(grants, input.ttlMinutes ?? 15, db);
  const payload: CodePayload = { v: 1, u: input.endpoint.replace(/\/+$/, ""), i: ensureInstanceIdentity(db).id, ...(input.fingerprint ? { f: input.fingerprint } : {}), s: secret };
  return { code: CODE_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url"), expiresAt, grants };
}

export function decodePairingCode(code: string): { endpoint: string; instanceId: string; fingerprint: string | null; secret: string } {
  try {
    if (!code.startsWith(CODE_PREFIX)) throw new Error("prefix");
    const payload = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), "base64url").toString("utf8")) as Partial<CodePayload>;
    if (payload.v !== 1 || typeof payload.u !== "string" || typeof payload.i !== "string" || typeof payload.s !== "string") throw new Error("shape");
    return { endpoint: payload.u, instanceId: payload.i, fingerprint: typeof payload.f === "string" ? payload.f : null, secret: payload.s };
  } catch {
    throw new PeerError(400, "That is not a Stackport pairing code.", "bad-code");
  }
}

// ── managed side: a controller presents the code ──────────────────────────────

export interface PairResult {
  protocol: string;
  versions: readonly number[];
  instance: { id: string; name: string };
  key: string;
  grants: Grant[];
}

/** Printable characters only: a peer's name is shown in other people's UI and written to logs. Null when nothing usable is left. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[^\p{L}\p{N} ._()'-]/gu, "").trim().slice(0, 80) || null;
}

export function acceptPairing(input: { secret: unknown; controller: { id: unknown; name: unknown } }, db: Database.Database = getDatabase()): PairResult {
  const { secret, controller } = input;
  if (typeof secret !== "string" || typeof controller?.id !== "string" || typeof controller?.name !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(controller.id)) {
    throw new PeerError(400, "A pairing request needs the code's secret and the controller's id and name.", "bad-request");
  }
  const self = ensureInstanceIdentity(db);
  if (controller.id === self.id) throw new PeerError(400, "An instance cannot be paired with itself.", "self-pairing");
  const grants = consumePairingSecret(secret, db);
  if (!grants) throw new PeerError(403, "The pairing code is invalid, expired or already used.", "bad-code");
  // Printable characters only: the name is shown in other people's UI and written to logs.
  const name = cleanName(controller.name) ?? "Stackport";
  const { key, previous } = upsertController({ instanceId: controller.id, name, grants }, db);
  // A code spent by an instance that is already paired replaces its key and grants: record that, with what it had.
  auditLog(`peer:${controller.id}`, previous ? "peer.re-paired" : "peer.paired", self.id, "ok", { grants, ...(previous ? { previousGrants: previous.grants, wasRevoked: previous.revokedAt !== null } : {}) });
  return { protocol: PROTOCOL_NAME, versions: PROTOCOL_VERSIONS, instance: self, key, grants };
}

// ── controlling side: register a peer from its code ───────────────────────────

export async function registerTarget(code: string, db: Database.Database = getDatabase()): Promise<Target> {
  const decoded = decodePairingCode(code.trim());
  const self = ensureInstanceIdentity(db);
  if (decoded.instanceId === self.id) throw new PeerError(400, "That pairing code was issued by this instance.", "self-pairing");
  checkEndpoint(decoded.endpoint);

  let response;
  try {
    response = await pairCall<PairResult & { error?: string; code?: string }>(decoded.endpoint, decoded.fingerprint, { secret: decoded.secret, controller: { id: self.id, name: self.name } });
  } catch (error) {
    if (error instanceof PeerIdentityError) throw new PeerError(502, error.message, "identity-mismatch");
    if (error instanceof PeerUnreachable) throw new PeerError(502, error.message, "unreachable");
    throw error;
  }
  if (response.status !== 200 || !response.body?.key) throw new PeerError(response.status === 403 ? 403 : 502, response.body?.error ?? "The peer refused the pairing.", response.body?.code ?? "refused");
  // The code names the instance it was issued by; the answering server must be that instance, or the endpoint was redirected somewhere else.
  if (response.body.instance?.id !== decoded.instanceId) throw new PeerError(502, "The server that answered is not the instance that issued the code.", "identity-mismatch");
  if (!response.body.versions?.some((v) => PROTOCOL_VERSIONS.includes(v))) throw new PeerError(502, "The peer does not speak a protocol version this instance understands.", "version-mismatch");

  return addTarget({ instanceId: decoded.instanceId, name: cleanName(response.body.instance.name) ?? "Stackport", endpoint: decoded.endpoint, certFingerprint: decoded.fingerprint, key: response.body.key, grants: normalizeGrants(response.body.grants), protocol: 1 }, db);
}

// ── controlling side: keeping a target current ────────────────────────────────

export type PeerState = "online" | "offline" | "revoked" | "identity-mismatch" | "version-mismatch" | "unknown";

export interface TargetStatus {
  state: PeerState;
  message?: string;
}

/** Calls hello on the peer: confirms identity, refreshes its name and the grants it currently gives this instance. */
export async function refreshTarget(id: number, db: Database.Database = getDatabase()): Promise<TargetStatus> {
  const target = getTarget(id, db);
  const key = targetKey(id, db);
  if (!target || !key) throw new PeerError(404, "No such peer.", "not-found");
  const self = ensureInstanceIdentity(db);
  try {
    const response = await signedCall<{ instance?: { id: string; name: string }; grants?: string[]; versions?: number[]; error?: string; code?: string }>({ endpoint: target.endpoint, fingerprint: target.certFingerprint, key, selfId: self.id, targetId: target.instanceId, method: "GET", path: "/control/v1/hello" });
    // A refusal is believed only when it is signed with the shared key: a proxy or another server can send any status and body.
    if (response.status === 403 && response.body?.code === "peer-revoked" && response.verified) return { state: "revoked", message: "The peer has revoked this instance's access." };
    if (response.status === 426) return { state: "version-mismatch", message: "The peer does not speak a protocol version this instance understands." };
    if (response.status === 421) return { state: "identity-mismatch", message: "The server at this address is not the registered instance." };
    if (response.status === 401) return { state: "offline", message: "The peer did not accept this instance's credentials (check both clocks, or re-pair)." };
    if (response.status !== 200) return { state: "offline", message: response.body?.error ?? `The peer answered with status ${response.status}.` };
    if (!response.verified) return { state: "identity-mismatch", message: "The peer's answer was not signed with the shared key: it may not be the registered instance." };
    if (response.body?.instance?.id !== target.instanceId) return { state: "identity-mismatch", message: "The instance behind this address is not the one that was registered." };
    // The answer is signed, so it comes from the peer, but its content is still the peer's: check types and bound sizes before storing.
    const grants = Array.isArray(response.body.grants) ? parseGrants(response.body.grants.filter((g): g is string => typeof g === "string").join(",")) : [];
    updateTarget(id, { name: cleanName(response.body.instance?.name) ?? target.name, grants, seen: true }, db);
    return { state: "online" };
  } catch (error) {
    if (error instanceof PeerIdentityError) return { state: "identity-mismatch", message: error.message };
    if (error instanceof PeerUnreachable) return { state: "offline", message: error.message };
    throw error;
  }
}

/** Rotates the shared key: the peer issues a new one, and this instance switches only once it has it. */
export async function rotateTargetKey(id: number, db: Database.Database = getDatabase()): Promise<void> {
  const target = getTarget(id, db);
  const key = targetKey(id, db);
  if (!target || !key) throw new PeerError(404, "No such peer.", "not-found");
  const self = ensureInstanceIdentity(db);
  // This side chooses the key and repeats the call if the answer is lost: the peer treats a repeat as already done, so the two
  // sides cannot end up on different keys. The old key stays valid on the peer until the new one is first used.
  const next = newKey();
  // Only a clear refusal stops the loop. Anything else (a network error, a gateway error, an answer that is not signed) may
  // follow a rotation the peer did apply, and the call is safe to repeat, so it is repeated.
  const REFUSED = new Set([400, 401, 403, 421, 426]);
  let lastMessage = "The peer did not answer.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await signedCall<{ error?: string }>({ endpoint: target.endpoint, fingerprint: target.certFingerprint, key, selfId: self.id, targetId: target.instanceId, method: "POST", path: "/control/v1/rotate", body: { key: next }, operationId: `rotate-${next.slice(0, 8)}` });
      if (response.status === 200 && response.verified) { updateTarget(id, { key: next }, db); return; }
      if (REFUSED.has(response.status)) throw new PeerError(502, response.body?.error ?? "The peer refused the new key.", "rotate-failed");
      lastMessage = response.body?.error ?? `The peer answered with status ${response.status}.`;
    } catch (error) {
      if (error instanceof PeerError) throw error;
      if (error instanceof PeerIdentityError) throw new PeerError(502, error.message, "identity-mismatch");
      if (!(error instanceof PeerUnreachable)) throw error;
      lastMessage = error.message;
    }
  }
  throw new PeerError(502, `${lastMessage} The peer may have switched keys: the previous key stays valid for an hour, so repeat the rotation.`, "rotate-uncertain");
}

/** Stops controlling a peer. Tells it first so it can drop the controller; if it is unreachable the local record is still removed and the caller is told the peer was not notified. */
export async function removeTargetAndNotify(id: number, db: Database.Database = getDatabase()): Promise<{ notified: boolean }> {
  const target = getTarget(id, db);
  const key = targetKey(id, db);
  if (!target || !key) throw new PeerError(404, "No such peer.", "not-found");
  const self = ensureInstanceIdentity(db);
  let notified = false;
  try {
    const response = await signedCall({ endpoint: target.endpoint, fingerprint: target.certFingerprint, key, selfId: self.id, targetId: target.instanceId, method: "POST", path: "/control/v1/revoke", body: {}, operationId: `revoke-${Date.now()}`, timeoutMs: 5000 });
    // Counted only when the peer proved it is the peer: the revocation took effect (200) or was already in place (a signed 403).
    notified = response.verified && (response.status === 200 || (response.status === 403 && (response.body as { code?: string } | null)?.code === "peer-revoked"));
  } catch {
    notified = false;
  }
  removeTarget(id, db);
  return { notified };
}

export type { Controller, Target };

// ── controlling side: reading a peer's data ───────────────────────────────────

export const STATUS_PATH = "/control/v1/status";

export interface RemoteResult<T> {
  data: T;
  /** True when the peer could not be reached and this is what it last said. */
  stale: boolean;
  fetchedAt: string;
}

/** What each peer last said, in memory only: it lets an offline peer keep showing what was known, marked stale. A restart empties it, and nothing here
 *  is written to disk or to a backup. Responses that can carry secrets (logs) are never kept. */
const remoteCache = new Map<string, { data: unknown; fetchedAt: string }>();
const REMOTE_CACHE_MAX = 200;

/** The last answer for a path, without calling the peer; null when there is none. */
export function peekRemote<T>(targetId: number, path: string): { data: T; fetchedAt: string } | null {
  const entry = remoteCache.get(`${targetId}:${path}`);
  return entry ? { data: entry.data as T, fetchedAt: entry.fetchedAt } : null;
}

export function forgetRemoteCache(targetId: number): void {
  for (const key of remoteCache.keys()) if (key.startsWith(`${targetId}:`)) remoteCache.delete(key);
}

/** Throws unless this is an answer from the registered peer, signed with the shared key: a wrong version, a different server or a refusal of this instance's credentials is an error, not data. */
function assertFromPeer(response: { status: number; verified: boolean }): void {
  // The peer's rate limiter answers before it knows who is calling, so its answer is not signed: that is "slow down", not an impostor.
  if (response.status === 429) throw new PeerError(503, "The peer is rate limiting this instance; try again shortly.", "rate-limited");
  // Refused for size before the caller was known, so unsigned as well: too large for the channel, not an impostor.
  if (response.status === 413) throw new PeerError(413, "That is too large for the control channel (16 kB).", "too-large");
  if (response.status === 426) throw new PeerError(502, "The peer does not speak a protocol version this instance understands.", "version-mismatch");
  if (response.status === 421) throw new PeerError(502, "The server at this address is not the registered instance.", "identity-mismatch");
  if (!response.verified) throw new PeerError(502, response.status === 401 ? "The peer did not accept this instance's credentials (check both clocks, or re-pair)." : "The peer's answer was not signed with the shared key: it may not be the registered instance.", response.status === 401 ? "unauthenticated" : "identity-mismatch");
}

/** Reads that run `docker compose config`, git or the GitHub API on the peer take longer than a status read; a slow host must not look like an unreachable one. */
const SLOW_READS = /\/(ingress-targets|compose-policy|compose-variables|compose-env-files|branches|deploy-preview|rollback-preview)(\?|$)/;
function timeoutFor(method: string, path: string): number {
  if (method !== "GET") return 30_000;
  return SLOW_READS.test(path) ? 70_000 : 15_000;
}

export interface RemoteCall { status: number; body: unknown; replayed: boolean; text: string; contentType: string | null }

/** Signed request to a peer's project API (`/control/v1/api/...`), for the controller's UI. Unlike a read, the peer's own answer is passed on as it is
 *  (a validation error or a conflict is the point), once it is known to come from the registered peer. A write carries an operation id: when the answer
 *  is lost, repeating the call with the same id returns the first result instead of acting again. Nothing here is cached. */
export async function remoteCall(id: number, call: { method: string; path: string; body?: unknown; operationId?: string; /** A control route (`/control/...`) instead of the project API. */ control?: boolean; timeoutMs?: number }, db: Database.Database = getDatabase()): Promise<RemoteCall> {
  const target = getTarget(id, db);
  const key = targetKey(id, db);
  if (!target || !key) throw new PeerError(404, "No such peer.", "not-found");
  const self = ensureInstanceIdentity(db);
  try {
    const response = await signedCall<{ error?: string; code?: string } | null>({
      endpoint: target.endpoint, fingerprint: target.certFingerprint, key, selfId: self.id, targetId: target.instanceId,
      method: call.method, path: `${call.control ? "/control" : "/control/v1/api"}${call.path}`, body: call.body, operationId: call.operationId, timeoutMs: call.timeoutMs ?? timeoutFor(call.method, call.path),
    });
    assertFromPeer(response);
    // A signed 401 is the peer refusing this instance's credentials or clock. Passed on as a 401 it would sign the admin out of this instance's own UI.
    if (response.status === 401) throw new PeerError(502, response.body?.error ?? "The peer did not accept this instance's request.", response.body?.code ?? "unauthenticated");
    if (response.status === 403 && response.body?.code === "peer-revoked") { forgetRemoteCache(id); throw new PeerError(403, "The peer has revoked this instance's access.", "peer-revoked"); }
    return { status: response.status, body: response.body, replayed: response.replayed, text: response.text, contentType: response.contentType };
  } catch (error) {
    if (error instanceof PeerIdentityError) throw new PeerError(502, error.message, "identity-mismatch");
    if (error instanceof PeerUnreachable) throw new PeerError(502, error.message, "unreachable");
    throw error;
  }
}

/** Signed GET to a peer's control API. A refusal or an unsigned answer is an error here; only "could not reach it" may fall back to the last answer. */
export async function remoteGet<T>(id: number, path: string, options: { cache?: boolean; validate?: (body: unknown) => boolean } = {}, db: Database.Database = getDatabase()): Promise<RemoteResult<T>> {
  const target = getTarget(id, db);
  const key = targetKey(id, db);
  if (!target || !key) throw new PeerError(404, "No such peer.", "not-found");
  const self = ensureInstanceIdentity(db);
  const cacheKey = `${id}:${path}`;
  const useCache = options.cache !== false;
  try {
    const response = await signedCall<T & { error?: string; code?: string }>({ endpoint: target.endpoint, fingerprint: target.certFingerprint, key, selfId: self.id, targetId: target.instanceId, method: "GET", path });
    // Anything but an answer from the registered peer ends the fallback: a peer that refused, was replaced or changed must not be shown from memory once it goes quiet.
    try { assertFromPeer(response); } catch (error) { forgetRemoteCache(id); throw error; }
    if (response.status === 403) { forgetRemoteCache(id); throw new PeerError(403, response.body?.code === "peer-revoked" ? "The peer has revoked this instance's access." : response.body?.error ?? "The peer has not granted this.", response.body?.code === "peer-revoked" ? "peer-revoked" : "forbidden"); }
    if (response.status === 404) throw new PeerError(404, response.body?.error ?? "Not found on the peer.", "not-found");
    if (response.status !== 200) throw new PeerError(502, response.body?.error ?? `The peer answered with status ${response.status}.`, "peer-error");
    if (response.body === null || typeof response.body !== "object" || (options.validate && !options.validate(response.body))) throw new PeerError(502, "The peer's answer was not understood.", "peer-error");
    const fetchedAt = new Date().toISOString();
    if (useCache) {
      remoteCache.delete(cacheKey);
      remoteCache.set(cacheKey, { data: response.body, fetchedAt });
      if (remoteCache.size > REMOTE_CACHE_MAX) remoteCache.delete(remoteCache.keys().next().value as string);
    }
    updateTarget(id, { seen: true }, db);
    return { data: response.body as T, stale: false, fetchedAt };
  } catch (error) {
    if (error instanceof PeerIdentityError) { forgetRemoteCache(id); throw new PeerError(502, error.message, "identity-mismatch"); }
    if (error instanceof PeerUnreachable) {
      const last = useCache ? remoteCache.get(cacheKey) : undefined;
      if (last) return { data: last.data as T, stale: true, fetchedAt: last.fetchedAt };
      throw new PeerError(502, error.message, "unreachable");
    }
    throw error;
  }
}
