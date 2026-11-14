import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import Database from "better-sqlite3";
import migration from "../src/migrations/021_peers";
import { ensureInstanceIdentity, setInstanceName } from "../src/modules/backup/instance";
import { createControlRouter } from "../src/modules/peers/controlRouter";
import { GrantError, normalizeGrants } from "../src/modules/peers/grants";
import { assertEndpoint } from "../src/modules/peers/client";
import { acceptPairing, issuePairingCode, PeerError, refreshTarget, registerTarget, removeTargetAndNotify, rotateTargetKey } from "../src/modules/peers/service";
import { HEADERS, KEY_PATTERN, newNonce, signRequest } from "../src/modules/peers/signing";
import { addTarget, getControllerByInstance, listControllers, listTargets, revokeController, rotateControllerKey, targetKey } from "../src/modules/peers/store";

/** Two instances in one process: each gets its own database and its own HTTP server, so they only talk the way two hosts would. */
interface Instance { db: Database.Database; id: string; server: Server; url: string }

async function instance(name: string): Promise<Instance> {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  migration.up(db);
  const identity = ensureInstanceIdentity(db);
  setInstanceName(name, db);
  const app = express();
  app.use("/control", createControlRouter(() => db));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return { db, id: identity.id, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (...all: Instance[]): Promise<unknown> => Promise.all(all.map((i) => new Promise((resolve) => { i.server.closeAllConnections(); i.server.close(resolve); })));

/** B issues a code, A registers from it. Returns A's id for the target B. */
async function pair(a: Instance, b: Instance, grants: string[] = ["projects:write"]) {
  const { code } = issuePairingCode({ endpoint: b.url, grants }, b.db);
  const target = await registerTarget(code, a.db);
  return { code, target };
}

test("grants: unknown ones are refused and each grant brings what it needs", () => {
  assert.throws(() => normalizeGrants(["projects:read", "host:admin"]), GrantError);
  assert.throws(() => normalizeGrants([]), GrantError);
  assert.deepEqual(normalizeGrants(["projects:secrets"]), ["projects:read", "projects:env", "projects:secrets"]);
  assert.ok(normalizeGrants(["projects:shell"]).includes("projects:write"));
});

test("endpoints must be https, except plain http to this machine", () => {
  assert.throws(() => assertEndpoint("http://example.com"));
  assert.throws(() => assertEndpoint("https://user:pw@example.com"));
  assert.doesNotThrow(() => assertEndpoint("https://example.com"));
  assert.doesNotThrow(() => assertEndpoint("http://127.0.0.1:3000"));
});

test("pairing is directional: A controls B, and B gets no standing over A", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    assert.equal(target.instanceId, b.id);
    assert.equal(target.name, "Beta");
    assert.deepEqual(target.grants, ["projects:read", "projects:write"]);
    assert.equal(listControllers(b.db).length, 1);
    assert.equal(listControllers(b.db)[0].instanceId, a.id);
    assert.equal(listTargets(b.db).length, 0, "B does not control A");
    assert.equal(listControllers(a.db).length, 0, "A is not controlled by anyone");
    assert.deepEqual(await refreshTarget(target.id, a.db), { state: "online" });
  } finally { await close(a, b); }
});

test("a pairing code works once, and an expired or invented one is refused", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  const c = await instance("Gamma");
  try {
    const { code } = await pair(a, b);
    await assert.rejects(() => registerTarget(code, c.db), (e: unknown) => e instanceof PeerError && e.status === 403);
    await assert.rejects(() => registerTarget("spp1.garbage", a.db), (e: unknown) => e instanceof PeerError && e.code === "bad-code");
    const expired = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    b.db.prepare("UPDATE peer_pairing_codes SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    await assert.rejects(() => registerTarget(expired.code, c.db), (e: unknown) => e instanceof PeerError && e.status === 403);
  } finally { await close(a, b, c); }
});

test("an instance cannot be paired with itself", async () => {
  const a = await instance("Alpha");
  try {
    const { code } = issuePairingCode({ endpoint: a.url, grants: ["projects:read"] }, a.db);
    await assert.rejects(() => registerTarget(code, a.db), (e: unknown) => e instanceof PeerError && e.code === "self-pairing");
  } finally { await close(a); }
});

test("a rename on B reaches A on its next check, and nothing about identity changes", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    setInstanceName("Beta (production)", b.db);
    await refreshTarget(target.id, a.db);
    const after = listTargets(a.db)[0];
    assert.equal(after.name, "Beta (production)");
    assert.equal(after.instanceId, b.id);
    assert.equal(getControllerByInstance(a.id, b.db)?.revokedAt, null);
  } finally { await close(a, b); }
});

function signedFetch(from: Instance, toUrl: string, toId: string, key: string, init: { path?: string; timestamp?: string; nonce?: string; target?: string; tamper?: boolean } = {}): Promise<Response> {
  const path = init.path ?? "/control/v1/hello";
  const timestamp = init.timestamp ?? String(Date.now());
  const nonce = init.nonce ?? newNonce();
  const signature = signRequest(key, { method: "GET", path, from: from.id, to: toId, timestamp, nonce, body: Buffer.alloc(0) });
  return fetch(`${toUrl}${init.tamper ? `${path}?x=1` : path}`, {
    headers: { [HEADERS.protocol]: "1", [HEADERS.instance]: from.id, [HEADERS.target]: init.target ?? toId, [HEADERS.timestamp]: timestamp, [HEADERS.nonce]: nonce, [HEADERS.signature]: signature },
  });
}

test("requests are refused when replayed, stale, mis-signed, tampered or aimed at another instance", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    const key = targetKey(target.id, a.db) as string;

    const nonce = newNonce();
    assert.equal((await signedFetch(a, b.url, b.id, key, { nonce })).status, 200);
    const replay = await signedFetch(a, b.url, b.id, key, { nonce });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as { code: string }).code, "replay");

    const stale = await signedFetch(a, b.url, b.id, key, { timestamp: String(Date.now() - 10 * 60_000) });
    assert.equal(((await stale.json()) as { code: string }).code, "clock-skew");

    assert.equal((await signedFetch(a, b.url, b.id, "not-the-key")).status, 401);
    assert.equal((await signedFetch(a, b.url, b.id, key, { tamper: true })).status, 401, "a signature does not cover a different path");

    const wrong = await signedFetch(a, b.url, b.id, key, { target: "00000000-0000-0000-0000-000000000000" });
    assert.equal(wrong.status, 421);
    assert.equal(((await wrong.json()) as { code: string }).code, "wrong-target");

    const unknown = await signedFetch(b, b.url, b.id, key); // a caller B never paired with
    assert.equal(unknown.status, 401);
  } finally { await close(a, b); }
});

test("responses are signed with the shared key, so another server at the address is not taken for the peer", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  const impostor = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    // Point A's record at a different server that happens to hold nothing of the pairing.
    a.db.prepare("UPDATE peer_targets SET endpoint = ?").run(impostor.url);
    const status = await refreshTarget(target.id, a.db);
    assert.equal(status.state, "identity-mismatch");
  } finally { await close(a, b, impostor); }
});

test("B revoking A: A is told on its next check, and B's data is untouched", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    assert.equal((await refreshTarget(target.id, a.db)).state, "online");
    assert.ok(revokeController((getControllerByInstance(a.id, b.db) as { id: number }).id, b.db));
    assert.equal((await refreshTarget(target.id, a.db)).state, "revoked");
    // Re-pairing after a revoke needs a new code and restores access.
    const again = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    await registerTarget(again.code, a.db);
    assert.equal((await refreshTarget(target.id, a.db)).state, "online");
  } finally { await close(a, b); }
});

test("A removing B revokes the controller on B; an unreachable B is reported as not notified", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  const c = await instance("Gamma");
  try {
    const { target } = await pair(a, b);
    const removed = await removeTargetAndNotify(target.id, a.db);
    assert.equal(removed.notified, true);
    assert.equal(listTargets(a.db).length, 0);
    assert.ok(getControllerByInstance(a.id, b.db)?.revokedAt);

    const { target: second } = await pair(a, c);
    await close(c);
    const offline = await removeTargetAndNotify(second.id, a.db);
    assert.equal(offline.notified, false);
    assert.equal(listTargets(a.db).length, 0);
  } finally { await close(a, b); }
});

test("an unreachable peer shows as offline, and reconnects when it returns", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    const port = (b.server.address() as AddressInfo).port;
    await new Promise((resolve) => { b.server.closeAllConnections(); b.server.close(resolve); });
    assert.equal((await refreshTarget(target.id, a.db)).state, "offline");
    const app = express();
      app.use("/control", createControlRouter(() => b.db));
    b.server = await new Promise<Server>((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    assert.equal((await refreshTarget(target.id, a.db)).state, "online");
  } finally { await close(a, b); }
});

test("rotating the key: the old one works until the new one is first used", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    const before = targetKey(target.id, a.db) as string;
    await rotateTargetKey(target.id, a.db);
    const after = targetKey(target.id, a.db) as string;
    assert.notEqual(before, after);
    assert.match(after, KEY_PATTERN);
    assert.equal((await signedFetch(a, b.url, b.id, before)).status, 200, "the old key still verifies until the new one has been used");
    assert.equal((await refreshTarget(target.id, a.db)).state, "online", "the new key works");
    assert.equal((await signedFetch(a, b.url, b.id, before)).status, 401, "using the new key retires the old one");
  } finally { await close(a, b); }
});

test("a rotation whose answer was lost is recovered by repeating it", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    const key = targetKey(target.id, a.db) as string;
    const next = "N".repeat(43);
    const controller = getControllerByInstance(a.id, b.db) as { id: number };
    rotateControllerKey(controller.id, next, b.db); // B switched, but A never heard back
    rotateControllerKey(controller.id, next, b.db); // the retry is a no-op
    assert.equal((await signedFetch(a, b.url, b.id, key)).status, 200, "A, still on the old key, is not locked out");
    assert.equal((await signedFetch(a, b.url, b.id, next)).status, 200);
  } finally { await close(a, b); }
});

test("a 403 that is not signed by the peer does not mark it revoked or count as a notification", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  const liar = await instance("Liar");
  try {
    const { target } = await pair(a, b);
    liar.server.removeAllListeners("request");
    liar.server.on("request", (_req, res) => { res.statusCode = 403; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: "peer-revoked" })); });
    a.db.prepare("UPDATE peer_targets SET endpoint = ?").run(liar.url);
    assert.notEqual((await refreshTarget(target.id, a.db)).state, "revoked");
    assert.equal((await removeTargetAndNotify(target.id, a.db)).notified, false);
  } finally { await close(a, b, liar); }
});

test("large bodies and any content type are signed and read exactly as sent", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    const key = targetKey(target.id, a.db) as string;
    const body = Buffer.from(JSON.stringify({ key: "K".repeat(43), padding: "x".repeat(200_000) }));
    const timestamp = String(Date.now());
    const nonce = newNonce();
    const signature = signRequest(key, { method: "POST", path: "/control/v1/rotate", from: a.id, to: b.id, timestamp, nonce, body });
    const response = await fetch(`${b.url}/control/v1/rotate`, { method: "POST", body, headers: { "content-type": "text/plain", [HEADERS.protocol]: "1", [HEADERS.instance]: a.id, [HEADERS.target]: b.id, [HEADERS.timestamp]: timestamp, [HEADERS.nonce]: nonce, [HEADERS.signature]: signature } });
    assert.equal(response.status, 200);
  } finally { await close(a, b); }
});

test("re-pairing replaces the controller's grants, and the name it sends is sanitized", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    await pair(a, b, ["projects:destroy"]);
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    const secret = (JSON.parse(Buffer.from(code.slice(5), "base64url").toString()) as { s: string }).s;
    const result = acceptPairing({ secret, controller: { id: a.id, name: "Alpha\u0007\n<script>" } }, b.db);
    assert.deepEqual(result.grants, ["projects:read"]);
    assert.equal(getControllerByInstance(a.id, b.db)?.name, "Alphascript");
    assert.throws(() => acceptPairing({ secret: "x", controller: { id: "bad id with spaces", name: "n" } }, b.db), PeerError);
  } finally { await close(a, b); }
});

test("stored keys are encrypted at rest", async () => {
  const a = await instance("Alpha");
  const b = await instance("Beta");
  try {
    const { target } = await pair(a, b);
    const key = targetKey(target.id, a.db) as string;
    const row = a.db.prepare("SELECT key_enc FROM peer_targets").get() as { key_enc: string };
    assert.ok(!row.key_enc.includes(key));
    const ctl = b.db.prepare("SELECT key_enc FROM peer_controllers").get() as { key_enc: string };
    assert.ok(!ctl.key_enc.includes(key));
  } finally { await close(a, b); }
});

// ── certificate pinning ────────────────────────────────────────────────────────

function makeCert(): { cert: string; key: string; fingerprint: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-peer-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=127.0.0.1", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
    return { cert, key: fs.readFileSync(path.join(dir, "k.pem"), "utf8"), fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function tlsInstance(name: string, material: { cert: string; key: string }): Promise<Instance & { hits: () => number }> {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  migration.up(db);
  const identity = ensureInstanceIdentity(db);
  setInstanceName(name, db);
  let hits = 0;
  const app = express();
  app.use((_req, _res, next) => { hits += 1; next(); });
  app.use("/control", createControlRouter(() => db));
  const server = await new Promise<Server>((resolve) => { const s = https.createServer({ cert: material.cert, key: material.key }, app).listen(0, "127.0.0.1", () => resolve(s)); });
  return { db, id: identity.id, server, url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

const pki = makeCert();
const pinTest = pki ? test : test.skip; // needs the openssl binary

pinTest("a self-signed peer is reached by its pinned certificate, and a different certificate never receives the request", async () => {
  const good = pki as NonNullable<typeof pki>;
  const other = makeCert() as NonNullable<typeof pki>;
  const a = await instance("Alpha");
  const b = await tlsInstance("Beta", good);
  const impostor = await tlsInstance("Beta", other);
  const c = await instance("Gamma");
  try {
    const { code } = issuePairingCode({ endpoint: b.url, fingerprint: good.fingerprint, grants: ["projects:read"] }, b.db);
    const target = await registerTarget(code, a.db);
    assert.equal((await refreshTarget(target.id, a.db)).state, "online");

    // The same record pointed at a server with another certificate: the handshake completes there, but nothing may be sent.
    a.db.prepare("UPDATE peer_targets SET endpoint = ?").run(impostor.url);
    const before = impostor.hits();
    assert.equal((await refreshTarget(target.id, a.db)).state, "identity-mismatch");
    assert.equal(impostor.hits(), before, "the impostor received no request");

    // And a pairing code with the wrong pin never delivers its secret.
    const forged = issuePairingCode({ endpoint: impostor.url, fingerprint: good.fingerprint, grants: ["projects:read"] }, impostor.db);
    const attempts = impostor.hits();
    await assert.rejects(() => registerTarget(forged.code, c.db), (e: unknown) => e instanceof PeerError && e.code === "identity-mismatch");
    assert.equal(impostor.hits(), attempts, "the pairing secret was never sent");
  } finally { await close(a, b, impostor, c); }
});

test("addTarget re-registering the same instance updates it instead of duplicating", async () => {
  const a = await instance("Alpha");
  try {
    for (const name of ["one", "two"]) addTarget({ instanceId: "x", name, endpoint: "https://x.example", certFingerprint: null, key: "k", grants: ["projects:read"], protocol: 1 }, a.db);
    assert.equal(listTargets(a.db).length, 1);
    assert.equal(listTargets(a.db)[0].name, "two");
  } finally { await close(a); }
});
