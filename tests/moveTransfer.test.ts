import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import Database from "better-sqlite3";
import migration from "../src/migrations/021_peers";
import moves from "../src/migrations/023_project_moves";
import { exportProject } from "../src/modules/backup/projectArchive";
import { ensureInstanceIdentity, setInstanceName } from "../src/modules/backup/instance";
import { currentVolumeRoots } from "../src/modules/deployments/compose/managedVolumes";
import { PushError, pushArchive } from "../src/modules/moves/ticketPush";
import { settled } from "../src/modules/moves/transferIn";
import { issuePairingCode, registerTarget, remoteCall } from "../src/modules/peers/service";
import { sealEnvVariables } from "../src/modules/projects/envFiles";

const PASS = "a long enough passphrase for archives";
const made: string[] = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } });

async function startB(): Promise<{ url: string; db: Database.Database; stop: () => Promise<void> }> {
  const { default: app } = await import("../src/app");
  const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/config/database");
  initializeDatabase();
  const db = getDatabase();
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, db, stop: async () => { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); closeDatabase(); } };
}

function controller(name: string): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  migration.up(db);
  moves.up(db);
  ensureInstanceIdentity(db);
  setInstanceName(name, db);
  return db;
}

/** A project to move and its archive, made from B's own database (the same process stands in for the source). */
async function archiveOf(db: Database.Database): Promise<{ file: string; digest: string; dir: string }> {
  for (const table of ["project_domains", "project_env_files", "network_group_services", "tcp_exposures", "project_transfers_in", "projects"]) db.exec(`DELETE FROM ${table}`);
  const id = Number(db.prepare("INSERT INTO projects (name, source_type, internal_port) VALUES ('Shop','github', 3000)").run().lastInsertRowid);
  const sealed = sealEnvVariables([{ key: "DB_PASSWORD", value: "s3cret-value" }]);
  db.prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc) VALUES (?, '.env', ?, ?)").run(id, sealed.json, sealed.enc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-move-"));
  made.push(dir);
  const file = path.join(dir, "shop.spbackup");
  const manifest = await exportProject({ projectId: id, outPath: file, passphrase: PASS, roots: currentVolumeRoots() });
  // The ticket's key is the archive's passphrase: re-seal under it later per test, so export with the key the target hands out.
  return { file, digest: manifest.digest, dir };
}

async function prepare(a: Database.Database, targetId: number, name: string): Promise<{ transferId: string; token: string; archiveKey: string }> {
  const answer = await remoteCall(targetId, { method: "POST", path: "/v1/transfers", body: { name }, control: true }, a);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return answer.body as { transferId: string; token: string; archiveKey: string };
}

/** The archive, sealed under the key the ticket handed out (the source does the same: the controller passes the key along). */
async function sealedFor(b: Database.Database, key: string): Promise<{ file: string; digest: string }> {
  const project = b.prepare("SELECT id FROM projects WHERE name = 'Shop'").get() as { id: number };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-move-"));
  made.push(dir);
  const file = path.join(dir, "sealed.spbackup");
  const manifest = await exportProject({ projectId: project.id, outPath: file, passphrase: key, roots: currentVolumeRoots() });
  return { file, digest: manifest.digest };
}

test("a project arrives chunk by chunk, is checked, imported and verified against the source's digest", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    await archiveOf(b.db);
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:transfer"] }, b.db);
    const target = await registerTarget(code, a);
    assert.ok(target.grants.includes("projects:secrets"), "moving implies the right to see secrets");

    const ticket = await prepare(a, target.id, "Shop moved");
    const sealed = await sealedFor(b.db, ticket.archiveKey);
    const push = { endpoint: b.url, fingerprint: null, transferId: ticket.transferId, token: ticket.token };
    const sent = await pushArchive(sealed.file, push, { chunkBytes: 700 });
    assert.ok(sent.chunks > 2, "sent in several chunks");

    const imported = await remoteCall(target.id, { method: "POST", path: `/v1/transfers/${ticket.transferId}/import`, control: true }, a);
    assert.equal(imported.status, 200);
    await settled(ticket.transferId);
    const done = (await remoteCall(target.id, { method: "GET", path: `/v1/transfers/${ticket.transferId}`, control: true }, a)).body as { state: string; digest: string; projectId: number; error: string | null };
    assert.equal(done.error, null);
    assert.equal(done.state, "imported");
    assert.equal(done.digest, sealed.digest, "what the target wrote has the digest the source recorded");
    const row = b.db.prepare("SELECT name, paused FROM projects WHERE id = ?").get(done.projectId) as { name: string; paused: number };
    assert.deepEqual(row, { name: "Shop moved", paused: 1 });
    assert.equal(fs.existsSync(path.join(currentVolumeRoots().containerDataRoot, "transfers", ticket.transferId)), false, "the archive holding the secrets is gone once imported");

    // aborting removes what the move created
    const aborted = await remoteCall(target.id, { method: "POST", path: `/v1/transfers/${ticket.transferId}/abort`, control: true }, a);
    assert.equal(aborted.status, 200);
    assert.equal((b.db.prepare("SELECT COUNT(*) n FROM projects WHERE name = 'Shop moved'").get() as { n: number }).n, 0);
  } finally { a.close(); await b.stop(); }
});

test("the ticket is the only way in, and every chunk is checked", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    await archiveOf(b.db);
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:transfer"] }, b.db);
    const target = await registerTarget(code, a);
    const ticket = await prepare(a, target.id, "Guarded");
    const url = (suffix: string): string => `${b.url}/control/transfer/${ticket.transferId}${suffix}`;
    const put = (n: number, body: Buffer, sha: string, token = ticket.token): Promise<Response> => fetch(url(`/chunks/${n}`), { method: "PUT", headers: { authorization: `Bearer ${token}`, "x-sp-chunk-sha256": sha, "content-type": "application/octet-stream" }, body });
    const chunk = Buffer.from("hello archive");
    const sha = crypto.createHash("sha256").update(chunk).digest("hex");

    assert.equal((await put(0, chunk, sha, "x".repeat(43))).status, 401, "a wrong token");
    assert.equal((await fetch(url(""), { headers: {} })).status, 401, "no token");
    assert.equal((await put(0, chunk, "0".repeat(64))).status, 422, "a chunk that does not match its checksum");
    assert.equal((await put(1, chunk, sha)).status, 409, "out of order");
    assert.equal((await put(0, chunk, sha)).status, 200);
    assert.equal((await put(0, chunk, sha)).status, 200, "the same last chunk again is accepted once, not written twice");
    const status = await (await fetch(url(""), { headers: { authorization: `Bearer ${ticket.token}` } })).json() as { next: number; received: number };
    assert.deepEqual([status.next, status.received], [1, chunk.length]);

    // the whole must match: a wrong checksum fails the transfer and removes what was received
    const bad = await fetch(url("/complete"), { method: "POST", headers: { authorization: `Bearer ${ticket.token}`, "content-type": "application/json" }, body: JSON.stringify({ chunks: 1, size: chunk.length, sha256: "1".repeat(64) }) });
    assert.equal(bad.status, 422);
    const failed = (await remoteCall(target.id, { method: "GET", path: `/v1/transfers/${ticket.transferId}`, control: true }, a)).body as { state: string };
    assert.equal(failed.state, "failed");
    assert.equal((await put(1, chunk, sha)).status, 409, "a failed transfer takes no more chunks");

    // another controller's ticket is not visible, an expired one is refused
    const other = await prepare(a, target.id, "Expiring");
    b.db.prepare("UPDATE project_transfers_in SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), other.transferId);
    const expired = await fetch(`${b.url}/control/transfer/${other.transferId}`, { headers: { authorization: `Bearer ${other.token}` } });
    assert.equal(expired.status, 410);
  } finally { a.close(); await b.stop(); }
});

test("a controller without the transfer grant cannot ask for a ticket", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:write"] }, b.db);
    const target = await registerTarget(code, a);
    const refused = await remoteCall(target.id, { method: "POST", path: "/v1/transfers", body: { name: "Nope" }, control: true }, a);
    assert.equal(refused.status, 403);
    assert.equal((await remoteCall(target.id, { method: "GET", path: "/v1/domains", control: true }, a)).status, 403);
  } finally { a.close(); await b.stop(); }
});

test("a push resumes where the target is, and an unreachable target stops it with a reason", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    await archiveOf(b.db);
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:transfer"] }, b.db);
    const target = await registerTarget(code, a);
    const ticket = await prepare(a, target.id, "Resumed");
    const sealed = await sealedFor(b.db, ticket.archiveKey);
    const push = { endpoint: b.url, fingerprint: null, transferId: ticket.transferId, token: ticket.token };
    let sent = 0;
    await assert.rejects(() => pushArchive(sealed.file, push, { chunkBytes: 500, onProgress: () => { sent += 1; }, shouldStop: () => sent >= 2 }), (error: unknown) => error instanceof PushError && error.code === "stopped");
    const finished = await pushArchive(sealed.file, push, { chunkBytes: 500 });
    assert.ok(finished.chunks > 2);
    await remoteCall(target.id, { method: "POST", path: `/v1/transfers/${ticket.transferId}/import`, control: true }, a);
    await settled(ticket.transferId);
    const done = (await remoteCall(target.id, { method: "GET", path: `/v1/transfers/${ticket.transferId}`, control: true }, a)).body as { state: string; digest: string };
    assert.equal(done.state, "imported");
    assert.equal(done.digest, sealed.digest);
    await assert.rejects(() => pushArchive(sealed.file, { ...push, endpoint: "http://127.0.0.1:9" }, { sleepMs: () => 1 }), (error: unknown) => error instanceof PushError || error instanceof Error);
  } finally { a.close(); await b.stop(); }
});
