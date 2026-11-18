import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { currentVolumeRoots, managedVolumesRoot } from "../src/modules/deployments/compose/managedVolumes";
import { backupsDir, fullBackupFile, fullDeps, getFullBackup, reconcileFullBackups, startFullBackup } from "../src/modules/backup/fullBackup";
import { cancelRestore, confirmFull, finishProjects, inspectFull, readPlan, receiveUpload, restoreDeps } from "../src/modules/backup/fullRestore";
import type { VolumeEngine, VolumeSource } from "../src/modules/backup/volumeEngine";
import { sealEnvVariables } from "../src/modules/projects/envFiles";
import { expectedComposeProjectName } from "../src/modules/projects/workspace";

/** Docker, in memory: what runs, and the volumes' files. A tar is the JSON of the files, the tree digest a hash of it. */
class FakeDocker implements VolumeEngine {
  running = new Set<string>();
  volumes = new Map<string, Record<string, string>>();
  private key = (s: VolumeSource): string => (s.kind === "named" ? `named:${s.name}` : `bind:${s.hostPath}`);
  async runningContainers(composeProject?: string): Promise<string[]> { return composeProject && this.running.has(composeProject) ? ["web-1"] : []; }
  async namedVolumes(): Promise<{ name: string; key: string }[]> { return []; }
  async volumeExists(name: string): Promise<boolean> { return this.volumes.has(`named:${name}`); }
  async exportTar(source: VolumeSource, file: string): Promise<{ size: number; sha256: string }> {
    const body = Buffer.from(JSON.stringify(this.volumes.get(this.key(source)) ?? {}));
    fs.writeFileSync(file, body);
    return { size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
  }
  async importTar(source: VolumeSource, file: string): Promise<void> { this.volumes.set(this.key(source), JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>); }
  async treeDigest(source: VolumeSource): Promise<string> { return crypto.createHash("sha256").update(JSON.stringify(this.volumes.get(this.key(source)) ?? {})).digest("hex"); }
  async remove(source: VolumeSource): Promise<void> { this.volumes.delete(this.key(source)); }
}

let docker: FakeDocker;
const originalFull = { ...fullDeps };
const originalRestore = { ...restoreDeps };
const PASS = "a long enough passphrase";

beforeEach(async () => {
  docker = new FakeDocker();
  fullDeps.engine = async () => docker;
  restoreDeps.engine = async () => docker;
  restoreDeps.publish = async () => undefined;
  const { initializeDatabase, getDatabase } = await import("../src/config/database");
  initializeDatabase();
  const db = getDatabase();
  for (const table of ["project_domains", "project_env_files", "network_group_services", "tcp_exposures", "full_backups", "projects"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM sqlite_sequence");
  fs.rmSync(backupsDir(), { recursive: true, force: true });
  cancelRestore();
});
afterEach(() => { Object.assign(fullDeps, originalFull); Object.assign(restoreDeps, originalRestore); });

async function until<T>(read: () => T | null, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a full backup stops each project only while it is copied, and restores on another instance with its data, route, branch and commit", async () => {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO projects (name, source_type, internal_port, paused, auto_deploy_branch) VALUES ('Shop','github', 3000, 0, 'main')").run().lastInsertRowid);
  const sealed = sealEnvVariables([{ key: "DB_PASSWORD", value: "s3cret-value" }]);
  db.prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc) VALUES (?, '.env', ?, ?)").run(id, sealed.json, sealed.enc);
  db.prepare("INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port) VALUES (?, 'shop.example.com', 1, 'web', 3000)").run(id);
  db.prepare("INSERT INTO project_deployments (project_id, commit_sha, branch, status) VALUES (?, 'abc1234def', 'v2', 'active')").run(id);
  const roots = currentVolumeRoots();
  fs.mkdirSync(`${roots.containerDataRoot}/volumes/${id}`, { recursive: true });
  docker.volumes.set(`bind:${managedVolumesRoot(roots, id).host}`, { "db/PG_VERSION": "16", "uploads/a.png": "A" });
  const composeName = expectedComposeProjectName({ id, name: "Shop" });
  docker.running.add(composeName);
  let stops = 0;
  fullDeps.stop = async () => { stops += 1; docker.running.clear(); return { ok: true, output: "" }; };
  fullDeps.start = async () => { docker.running.add(composeName); return { ok: true, output: "" }; };

  await assert.rejects(() => startFullBackup("short", db), /at least 12/);
  const started = await startFullBackup(PASS, db);
  const done = await until(() => { const v = getFullBackup(started.id, db); return v && v.state !== "running" ? v : null; }, "the backup");
  assert.equal(done.state, "done", done.error ?? "");
  assert.equal(stops, 1, "the running project was stopped once, for its own copy");
  assert.deepEqual([...docker.running], [composeName], "and it runs again");
  assert.equal((db.prepare("SELECT paused FROM projects WHERE id = ?").get(id) as { paused: number }).paused, 0, "automation is back");
  assert.equal((db.prepare("SELECT quiesced_json FROM full_backups WHERE id = ?").get(started.id) as { quiesced_json: string }).quiesced_json, "{}");
  const file = fullBackupFile(started.id, db);
  assert.ok(file && file.size > 0);

  // Another instance: the upload, the inspection, and the restore.
  const uploaded = await receiveUpload(fs.createReadStream(file.path), file.size);
  assert.equal(uploaded.size, file.size);
  await assert.rejects(() => inspectFull("not the passphrase"), /./);
  const preview = await inspectFull(PASS, db);
  assert.deepEqual(preview.projects.map((p) => [p.name, p.hostnames, p.wasRunning]), [["Shop", ["shop.example.com"], true]]);
  assert.equal(preview.current.projects, 1);

  await assert.rejects(() => confirmFull({ passphrase: PASS, mode: "recover", confirm: "wrong name" }, db), /Type the name/);
  const launched: { file: string; mode: string }[] = [];
  restoreDeps.launchHostRestore = async (hostFile, mode, hostPassphrase) => {
    launched.push({ file: hostFile, mode });
    assert.ok(hostPassphrase.endsWith("/.passphrase"));
    assert.equal(fs.readFileSync(path.join(roots.containerDataRoot, "restore", ".passphrase"), "utf8"), PASS);
  };
  await confirmFull({ passphrase: PASS, mode: "recover", confirm: preview.confirmName }, db);
  assert.equal(launched.length, 1);
  assert.match(launched[0].file, /restore\/parts\/parts\/instance\.spbackup$/);
  assert.equal(readPlan()?.projects.length, 1);

  // The host replaced the database with the archive's level 1, which has no projects (simulated).
  db.exec("DELETE FROM project_domains; DELETE FROM project_env_files; DELETE FROM projects;");
  docker.volumes.clear();
  docker.running.clear();
  const deploys: { branch: string | null; commit: string | null }[] = [];
  restoreDeps.deploy = async (_id, branch, commit) => { deploys.push({ branch, commit }); docker.running.add("restored"); return { ok: true, output: "" }; };
  const issued: string[] = [];
  restoreDeps.issueSsl = async (_id, domain) => { issued.push(domain); return { ok: true, output: "" }; };

  await assert.rejects(() => finishProjects("", db), /passphrase/);
  await finishProjects(PASS, db);
  await until(() => (readPlan() === null ? true : null), "the restore to finish");
  const copy = db.prepare("SELECT id, name, paused FROM projects").get() as { id: number; name: string; paused: number };
  assert.equal(copy.name, "Shop");
  assert.equal(copy.paused, 0, "it was running, so it runs");
  assert.deepEqual(deploys, [{ branch: "v2", commit: "abc1234def" }], "the branch and commit that ran");
  const domain = db.prepare("SELECT domain, service, container_port, use_ssl FROM project_domains WHERE project_id = ?").get(copy.id) as { domain: string; service: string; container_port: number; use_ssl: number };
  assert.deepEqual({ ...domain }, { domain: "shop.example.com", service: "web", container_port: 3000, use_ssl: 0 });
  assert.deepEqual(issued, ["shop.example.com"], "the certificate is asked for the hostname that served TLS");
  assert.deepEqual(docker.volumes.get(`bind:${managedVolumesRoot(roots, copy.id).host}`), { "db/PG_VERSION": "16", "uploads/a.png": "A" }, "the data is back, verified");
});

test("a file that is not a full backup is refused, and so is an empty or oversized upload", async () => {
  await assert.rejects(() => receiveUpload(Readable.from([Buffer.from("x")]), 0), /size/);
  await receiveUpload(Readable.from([Buffer.from("not an archive at all")]), 21);
  await assert.rejects(() => inspectFull(PASS), /./);
});

test("a copy that fails gives every project back, and a restart in the middle does too", async () => {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO projects (name, source_type, paused) VALUES ('Shop','github', 0)").run().lastInsertRowid);
  fs.mkdirSync(`${currentVolumeRoots().containerDataRoot}/volumes/${id}`, { recursive: true });
  const composeName = expectedComposeProjectName({ id, name: "Shop" });
  docker.running.add(composeName);
  fullDeps.stop = async () => { docker.running.clear(); return { ok: true, output: "" }; };
  fullDeps.start = async () => { docker.running.add(composeName); return { ok: true, output: "" }; };
  docker.exportTar = async () => { throw new Error("the disk is full"); };

  const started = await startFullBackup(PASS, db);
  const failed = await until(() => { const v = getFullBackup(started.id, db); return v && v.state !== "running" ? v : null; }, "the failure");
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /disk is full/);
  assert.deepEqual([...docker.running], [composeName], "the project is running again");
  assert.equal((db.prepare("SELECT paused FROM projects WHERE id = ?").get(id) as { paused: number }).paused, 0);

  // A restart while a project was stopped: the record says what to give back.
  docker.running.clear();
  db.prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(id);
  db.prepare("INSERT INTO full_backups (id, state, quiesced_json, created_at, updated_at) VALUES ('11111111-1111-1111-1111-111111111111', 'running', ?, ?, ?)").run(JSON.stringify({ [String(id)]: { wasRunning: true, paused: false } }), new Date().toISOString(), new Date().toISOString());
  await reconcileFullBackups(db);
  assert.deepEqual([...docker.running], [composeName], "started again after the restart");
  assert.equal((db.prepare("SELECT paused FROM projects WHERE id = ?").get(id) as { paused: number }).paused, 0);
  assert.equal(getFullBackup("11111111-1111-1111-1111-111111111111", db)?.state, "failed");
});
