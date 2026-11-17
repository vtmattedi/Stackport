import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import type { AddressInfo } from "net";
import type { Server } from "http";
import Database from "better-sqlite3";
import migration from "../src/migrations/021_peers";
import moves from "../src/migrations/023_project_moves";
import { actionRegistry, projectRepoKey } from "../src/modules/actions/registry";
import { ensureInstanceIdentity, setInstanceName } from "../src/modules/backup/instance";
import type { VolumeEngine, VolumeSource } from "../src/modules/backup/volumeEngine";
import { currentVolumeRoots, managedVolumesRoot } from "../src/modules/deployments/compose/managedVolumes";
import { deps as moveDeps } from "../src/modules/moves/moveOut";
import { transferDeps } from "../src/modules/moves/transferIn";
import { decide, getMoveRun, startMove, timing, type MoveRun } from "../src/modules/peers/moveOrchestrator";
import { PeerError, issuePairingCode, registerTarget, remoteCall } from "../src/modules/peers/service";
import { sealEnvVariables } from "../src/modules/projects/envFiles";

/** Docker, in memory: what is running, and the volumes' files. A tar is the JSON of the files, the tree digest a hash of the same. */
class FakeDocker implements VolumeEngine {
  running: string[] = [];
  volumes = new Map<string, Record<string, string>>();
  dropOnImport: string | null = null;
  stopped = 0;
  started = 0;
  private key = (source: VolumeSource): string => (source.kind === "named" ? `named:${source.name}` : `bind:${source.hostPath}`);
  deployed = false;
  // The source is project 1; a copy made by a move is another project, running once it has been deployed.
  async runningContainers(composeProject?: string): Promise<string[]> { return composeProject && !composeProject.startsWith("1-") ? (this.deployed ? ["web-1"] : []) : this.running; }
  async namedVolumes(): Promise<{ name: string; key: string }[]> { return []; }
  async volumeExists(name: string): Promise<boolean> { return this.volumes.has(`named:${name}`); }
  async exportTar(source: VolumeSource, file: string): Promise<{ size: number; sha256: string }> {
    const body = Buffer.from(JSON.stringify(this.volumes.get(this.key(source)) ?? {}));
    fs.writeFileSync(file, body);
    return { size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
  }
  async importTar(source: VolumeSource, file: string): Promise<void> {
    const files = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
    if (this.dropOnImport) delete files[this.dropOnImport];
    this.volumes.set(this.key(source), files);
  }
  async treeDigest(source: VolumeSource): Promise<string> { return crypto.createHash("sha256").update(JSON.stringify(this.volumes.get(this.key(source)) ?? {})).digest("hex"); }
  async remove(source: VolumeSource): Promise<void> { this.volumes.delete(this.key(source)); }
}

let docker: FakeDocker;
const originalMove = { ...moveDeps };
const originalTransfer = { ...transferDeps };
const originalTiming = { ...timing };

beforeEach(() => {
  docker = new FakeDocker();
  moveDeps.engine = async () => docker;
  moveDeps.stop = async () => { docker.running = []; docker.stopped += 1; return { ok: true, output: "" }; };
  moveDeps.start = async () => { docker.running = ["web-1"]; docker.started += 1; return { ok: true, output: "" }; };
  moveDeps.purge = async () => undefined;
  moveDeps.leaseMs = 60_000;
  moveDeps.pollMs = 20;
  transferDeps.engine = async () => docker;
  transferDeps.deploy = async () => { docker.deployed = true; return { ok: true, output: "" }; };
  transferDeps.publish = async () => undefined;
  transferDeps.issueSsl = async () => ({ ok: true, output: "" });
  transferDeps.purge = async () => undefined;
  Object.assign(timing, { pollMs: 20, renewMs: 50, healthTimeoutMs: 2000, stepTimeoutMs: 20_000, confirmTimeoutMs: 20_000 });
});
afterEach(() => { Object.assign(moveDeps, originalMove); Object.assign(transferDeps, originalTransfer); Object.assign(timing, originalTiming); });
after(() => undefined);

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

/** A running project with an env file and a managed directory holding data. Returns its id. */
function seedProject(b: Database.Database): number {
  for (const table of ["project_domains", "project_env_files", "network_group_services", "tcp_exposures", "project_transfers_in", "project_moves_out", "projects"]) b.exec(`DELETE FROM ${table}`);
  b.exec("DELETE FROM sqlite_sequence");
  const id = Number(b.prepare("INSERT INTO projects (name, source_type, internal_port, paused) VALUES ('Shop','github', 3000, 0)").run().lastInsertRowid);
  const sealed = sealEnvVariables([{ key: "DB_PASSWORD", value: "s3cret-value" }]);
  b.prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc) VALUES (?, '.env', ?, ?)").run(id, sealed.json, sealed.enc);
  const roots = currentVolumeRoots();
  fs.rmSync(`${roots.containerDataRoot}/volumes`, { recursive: true, force: true }); // ids restart from 1 in every scenario: no directory of an earlier one may linger
  fs.mkdirSync(`${roots.containerDataRoot}/volumes/${id}`, { recursive: true });
  docker.volumes.set(`bind:${managedVolumesRoot(roots, id).host}`, { "uploads/a.png": "A", "db/PG_VERSION": "16" });
  docker.running = ["web-1"];
  return id;
}

async function pair(b: { url: string; db: Database.Database }, a: Database.Database, grants: string[]): Promise<number> {
  const { code } = issuePairingCode({ endpoint: b.url, grants }, b.db);
  return (await registerTarget(code, a)).id;
}

async function until(a: Database.Database, id: string, wanted: (run: MoveRun) => boolean, what: string): Promise<MoveRun> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const run = await getMoveRun(id, a);
    if (wanted(run)) return run;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; the move is ${run.state}: ${run.error ?? JSON.stringify(run.steps.slice(-2))}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const exists = (b: Database.Database, name: string): boolean => !!b.prepare("SELECT 1 FROM projects WHERE name = ?").get(name);
const paused = (b: Database.Database, name: string): number => (b.prepare("SELECT paused FROM projects WHERE name = ?").get(name) as { paused: number }).paused;

test("a move stops the source, verifies the copy, starts it, and removes the source only when confirmed", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);

    const waiting = await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be verified and started");
    // The source is stopped and held; the target's copy is running and verified against the source's digest.
    assert.deepEqual(docker.running, [], "the source is stopped");
    assert.equal(paused(b.db, "Shop"), 1, "nothing deploys it by itself");
    assert.equal(actionRegistry.get(projectRepoKey(projectId))?.kind, "move", "the move holds the project's action slot");
    assert.equal(actionRegistry.get(projectRepoKey(projectId))?.status, "running");
    assert.equal(actionRegistry.tryStart(projectRepoKey(projectId), "deploy", { projectId }, async () => ({ ok: true })), null, "a deploy finds the project busy");
    assert.equal(waiting.transfer?.state, "started");
    assert.equal(waiting.transfer?.digest, waiting.sourceMove?.digest, "both sides attest the same digest");
    assert.equal(exists(b.db, "Shop on target"), true);
    const copy = b.db.prepare("SELECT id FROM projects WHERE name = 'Shop on target'").get() as { id: number };
    assert.deepEqual(docker.volumes.get(`bind:${managedVolumesRoot(currentVolumeRoots(), copy.id).host}`), { "uploads/a.png": "A", "db/PG_VERSION": "16" }, "the data is on the target");

    // Destroying the source needs the digest it recorded: a wrong one destroys nothing.
    const refused = await remoteCall(peerId, { method: "POST", path: `/v1/moves/${waiting.sourceMove?.id}/commit`, body: { digest: "0".repeat(64) }, control: true }, a);
    assert.equal(refused.status, 409);
    assert.equal(exists(b.db, "Shop"), true, "nothing was destroyed");

    await decide(run.id, "confirm", a);
    const done = await until(a, run.id, (r) => r.state === "done", "the move to finish");
    assert.equal(done.error, null);
    assert.equal(exists(b.db, "Shop"), false, "the source is gone");
    assert.equal(exists(b.db, "Shop on target"), true, "the target keeps the project");
    assert.equal(docker.volumes.has(`bind:${managedVolumesRoot(currentVolumeRoots(), projectId).host}`), false, "the source's data was removed through the helper");
    assert.equal((b.db.prepare("SELECT state FROM project_transfers_in").get() as { state: string }).state, "committed");
    assert.equal((b.db.prepare("SELECT state FROM project_moves_out").get() as { state: string }).state, "committed");
    assert.equal(actionRegistry.get(projectRepoKey(projectId))?.status, "success", "the slot is released");
  } finally { a.close(); await b.stop(); }
});

test("the hostname keeps where it routed and its TLS, the project keeps its branch and commit, and the certificate is issued when the move is confirmed", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    b.db.exec("DELETE FROM managed_domains");
    b.db.prepare("INSERT INTO managed_domains (name, is_default) VALUES ('example.com', 1)").run();
    const added = Number(b.db.prepare("INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port) VALUES (?, 'shop.example.com', 1, 'web', 3000)").run(projectId).lastInsertRowid);
    b.db.prepare("UPDATE projects SET health_check_domain_id = ?, auto_deploy_branch = 'main' WHERE id = ?").run(added, projectId);
    b.db.prepare("INSERT INTO project_deployments (project_id, commit_sha, branch, status) VALUES (?, 'abc1234def', 'v2', 'active')").run(projectId);
    const deploys: { branch: string | null; commit: string | null }[] = [];
    transferDeps.deploy = async (_id, branch, commit) => { deploys.push({ branch: branch ?? null, commit: commit ?? null }); docker.deployed = true; return { ok: true, output: "" }; };
    const issued: string[] = [];
    transferDeps.issueSsl = async (_id, domain) => { issued.push(domain); return { ok: true, output: "" }; };

    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", domains: [{ domain: "new.example.com", from: "shop.example.com" }], allowSameInstance: true }, a);
    await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");

    const copy = b.db.prepare("SELECT id, health_check_domain_id, auto_deploy_branch FROM projects WHERE name = 'Shop on target'").get() as { id: number; health_check_domain_id: number; auto_deploy_branch: string };
    const domain = b.db.prepare("SELECT * FROM project_domains WHERE project_id = ?").get(copy.id) as { id: number; domain: string; service: string; container_port: number; use_ssl: number; managed_domain_id: number | null; label: string | null };
    assert.equal(domain.domain, "new.example.com");
    assert.equal(domain.service, "web", "the compose service it routed to comes along");
    assert.equal(domain.container_port, 3000, "and the container port");
    assert.equal(domain.use_ssl, 0, "no certificate exists here yet: it starts on HTTP");
    assert.equal(domain.label, "new", "it is a hostname of the target's own managed domain");
    assert.ok(domain.managed_domain_id);
    assert.equal(copy.health_check_domain_id, domain.id, "the health check goes through it");
    assert.equal(copy.auto_deploy_branch, "main", "the configured branch is the source's");
    assert.deepEqual(deploys, [{ branch: "v2", commit: "abc1234def" }], "the first deploy is the branch and commit that ran on the source");
    assert.deepEqual(issued, [], "no certificate before the move is confirmed");

    await decide(run.id, "confirm", a);
    await until(a, run.id, (r) => r.state === "done", "the move to finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(issued, ["new.example.com"], "the certificate is issued for the hostname that served TLS on the source");
    const notes = JSON.parse((b.db.prepare("SELECT warnings_json FROM project_transfers_in").get() as { warnings_json: string }).warnings_json) as { warnings: string[] };
    assert.ok(notes.warnings.some((w) => w.includes("new.example.com") && w.includes("issued")), "and the transfer says so");
  } finally { a.close(); await b.stop(); }
});

test("aborting gives the project back exactly as it was and removes the copy", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    b.db.prepare("UPDATE projects SET favorite = 1 WHERE id = ?").run(projectId);
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");
    const aborted = await decide(run.id, "abort", a);
    assert.equal(aborted.state, "aborted");
    assert.equal(exists(b.db, "Shop on target"), false, "the copy is removed");
    assert.equal(exists(b.db, "Shop"), true);
    assert.equal(paused(b.db, "Shop"), 0, "automation is back as it was");
    assert.deepEqual(docker.running, ["web-1"], "and it is running again");
    assert.equal((b.db.prepare("SELECT state FROM project_moves_out").get() as { state: string }).state, "rolled-back");
    assert.equal((b.db.prepare("SELECT state FROM project_transfers_in").get() as { state: string }).state, "aborted");
    assert.notEqual(actionRegistry.get(projectRepoKey(projectId))?.status, "running", "the slot is released");
  } finally { a.close(); await b.stop(); }
});

test("a project that was stopped before the move stays stopped when the move is undone", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    docker.running = [];
    b.db.prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(projectId);
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");
    await decide(run.id, "abort", a);
    assert.equal(docker.started, 0, "it was not running before, so it is not started");
    assert.equal(paused(b.db, "Shop"), 1, "and it is still paused");
  } finally { a.close(); await b.stop(); }
});

test("a copy that does not match is never confirmed: everything goes back", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    docker.dropOnImport = "db/PG_VERSION"; // the target loses a file while writing
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    const failed = await until(a, run.id, (r) => r.state === "failed" || r.state === "needs-attention", "the move to fail");
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /digest|match|verif/i);
    assert.equal(exists(b.db, "Shop on target"), false, "no copy is left");
    assert.equal(paused(b.db, "Shop"), 0);
    assert.deepEqual(docker.running, ["web-1"], "the source is running again");
  } finally { a.close(); await b.stop(); }
});

test("a controller that goes away: the source takes the project back by itself, and the copy is not confirmed", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    moveDeps.leaseMs = 1200;
    timing.renewMs = 10 * 60_000; // never renewed
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    const ended = await until(a, run.id, (r) => r.state === "failed" || r.state === "aborted" || r.state === "needs-attention", "the lease to lapse");
    assert.notEqual(ended.state, "needs-attention", ended.error ?? "");
    assert.equal(paused(b.db, "Shop"), 0);
    assert.deepEqual(docker.running, ["web-1"], "restored by the source itself");
    assert.equal(exists(b.db, "Shop on target"), false);
  } finally { a.close(); await b.stop(); }
});

test("a source whose restore fails says so loudly instead of looking fine", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    moveDeps.start = async () => ({ ok: false, output: "port is already allocated" });
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");
    const result = await decide(run.id, "abort", a);
    assert.equal(result.state, "needs-attention");
    assert.match(result.error ?? "", /could not be restored|started again/i);
    assert.equal((b.db.prepare("SELECT state FROM project_moves_out").get() as { state: string }).state, "needs-attention");
  } finally { a.close(); await b.stop(); }
});

test("who may move: both grants on the source, the transfer grant on the target, never the same instance twice", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    const noDestroy = await pair(b, a, ["projects:transfer"]);
    assert.throws(() => startMove({ source: { kind: "peer", peerId: noDestroy }, target: { kind: "local" }, projectId, projectName: "Shop" }, a), (error: unknown) => error instanceof PeerError && error.status === 403 && /projects:destroy/.test(error.message));
    assert.throws(() => startMove({ source: { kind: "local" }, target: { kind: "local" }, projectId, projectName: "Shop" }, a), (error: unknown) => error instanceof PeerError && error.status === 400);
  } finally { a.close(); await b.stop(); }
});

test("an abort cannot be turned into a confirmation, and a restart in the middle of a commit is reported, not retried forever", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");
    const aborting = decide(run.id, "abort", a);
    await assert.rejects(() => decide(run.id, "confirm", a), (error: unknown) => error instanceof PeerError && error.status === 409);
    assert.equal((await aborting).state, "aborted");
    assert.equal(exists(b.db, "Shop"), true, "the source was not destroyed by a late confirmation");

    // a move left in "committing" by a restart: nothing to roll back to, so it says so and stops being retried
    const { reconcileMoves } = await import("../src/modules/moves/moveOut");
    b.db.prepare("UPDATE project_moves_out SET state = 'committing'").run();
    await reconcileMoves(b.db);
    const row = b.db.prepare("SELECT state, error FROM project_moves_out").get() as { state: string; error: string };
    assert.equal(row.state, "needs-attention");
    assert.match(row.error, /restarted while the source was being removed/);
    const id = (b.db.prepare("SELECT id FROM project_moves_out").get() as { id: string }).id;
    const refused = await remoteCall(peerId, { method: "POST", path: `/v1/moves/${id}/abort`, control: true }, a);
    assert.equal(refused.status, 409, "a confirmed move cannot be aborted");
  } finally { a.close(); await b.stop(); }
});

test("a controller that restarts after the target committed finishes removing the original instead of leaving two copies", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const run = startMove({ source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true }, a);
    const waiting = await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");
    const transferId = waiting.transfer?.id ?? (b.db.prepare("SELECT id FROM project_transfers_in").get() as { id: string }).id;
    const sourceMoveId = waiting.sourceMove?.id as string;
    const digest = waiting.sourceMove?.digest as string;

    // The target commits; the controller dies before it tells the source. A second record stands in for the run this process lost.
    const committed = await remoteCall(peerId, { method: "POST", path: `/v1/transfers/${transferId}/commit`, control: true }, a);
    assert.equal(committed.status, 200);
    a.prepare("INSERT INTO peer_moves (id, source_json, target_json, project_name, state, steps_json, refs_json, created_at, updated_at) VALUES ('lost-run', ?, ?, 'Shop', 'committing', '[]', ?, ?, ?)")
      .run(JSON.stringify(ref), JSON.stringify(ref), JSON.stringify({ transferId, sourceMoveId, digest }), new Date().toISOString(), new Date().toISOString());
    const { reconcileRuns } = await import("../src/modules/peers/moveOrchestrator");
    await reconcileRuns(a);
    const finished = a.prepare("SELECT state, error FROM peer_moves WHERE id = 'lost-run'").get() as { state: string; error: string | null };
    assert.equal(finished.state, "done", finished.error ?? "");
    assert.equal(exists(b.db, "Shop"), false, "the original is removed");
    assert.equal(exists(b.db, "Shop on target"), true, "the committed copy stays");
  } finally { a.close(); await b.stop(); }
});

test("a GitHub project is cloned on the target with the target's own credentials, chosen before anything is stopped", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const projectId = seedProject(b.db);
    b.db.prepare("UPDATE projects SET github_repo = 'owner/site', github_credential_id = NULL WHERE id = ?").run(projectId);
    b.db.exec("DELETE FROM credentials");
    const credentialId = Number(b.db.prepare("INSERT INTO credentials (type, alias, secret_enc) VALUES ('github', 'target-token', 'x')").run().lastInsertRowid);
    const peerId = await pair(b, a, ["projects:transfer", "projects:destroy"]);
    const ref = { kind: "peer", peerId } as const;
    const base = { source: ref, target: ref, projectId, projectName: "Shop", name: "Shop on target", allowSameInstance: true, githubRepo: "owner/site" } as const;

    // Refused up front, while the source still runs: no way to reach GitHub chosen, or one that does not exist.
    const noAuth = startMove(base, a);
    const failed = await until(a, noAuth.id, (r) => r.state === "failed", "the move to be refused");
    assert.match(failed.error ?? "", /how this instance reaches GitHub/i);
    assert.equal(docker.stopped, 0, "the source was never stopped");
    const missing = startMove({ ...base, auth: { mode: "token", credentialId: credentialId + 99 } }, a);
    assert.match((await until(a, missing.id, (r) => r.state === "failed", "the move to be refused")).error ?? "", /does not exist/);
    assert.equal(docker.stopped, 0);

    const run = startMove({ ...base, auth: { mode: "token", credentialId } }, a);
    await until(a, run.id, (r) => r.state === "awaiting-confirmation", "the copy to be started");
    const copy = b.db.prepare("SELECT github_credential_id AS cred, github_auth_mode AS mode FROM projects WHERE name = 'Shop on target'").get() as { cred: number; mode: string | null };
    assert.equal(copy.cred, credentialId, "the copy uses the target's token");
    assert.equal(copy.mode, null);
    await decide(run.id, "abort", a);
  } finally { a.close(); await b.stop(); }
});
