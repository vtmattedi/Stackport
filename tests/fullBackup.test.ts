import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { currentVolumeRoots, managedVolumesRoot } from "../src/modules/deployments/compose/managedVolumes";
import { backupsDir, deleteFullBackup, fullBackupFile, fullDeps, getFullBackup, reconcileFullBackups, startFullBackup } from "../src/modules/backup/fullBackup";
import { cancelRestore, confirmFull, finishProjects, inspectFull, readPlan, receiveUpload, restoreDeps, restoreStatus } from "../src/modules/backup/fullRestore";
import type { VolumeEngine, VolumeSource } from "../src/modules/backup/volumeEngine";
import { listProjectEnvFiles, sealEnvVariables } from "../src/modules/projects/envFiles";
import { createBranchDeployment, listBranchDeployments } from "../src/modules/projects/branchDeployments";
import { addManagedDomain } from "../src/modules/ingress/managedDomains";
import { expectedComposeProjectName } from "../src/modules/projects/workspace";
import { getProjectById } from "../src/modules/deployments/operations";
import { closeDatabase } from "../src/config/database";
import { config } from "../src/config/env";
import { restoreBackup } from "../src/modules/backup/restore";
import { actionRegistry, projectRepoKey } from "../src/modules/actions/registry";

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
const originalPaths = { sqlitePath: config.sqlitePath, deployRoot: config.deployRoot, scriptsDir: config.scriptsDir };

beforeEach(async () => {
  docker = new FakeDocker();
  fullDeps.engine = async () => docker;
  fullDeps.start = async (id) => {
    const project = getProjectById(id);
    assert.ok(project);
    // Exercise the real start guard: the previous stub accepted paused projects.
    if (project.paused) return originalFull.start(id);
    docker.running.add(expectedComposeProjectName(project));
    return { ok: true, output: "" };
  };
  restoreDeps.engine = async () => docker;
  restoreDeps.publish = async () => undefined;
  restoreDeps.hostRestoreStatus = async () => ({ state: "done", output: "" });
  const { initializeDatabase, getDatabase } = await import("../src/config/database");
  initializeDatabase();
  const db = getDatabase();
  for (const table of ["project_domains", "project_env_files", "network_group_services", "tcp_exposures", "full_backups", "projects"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM sqlite_sequence");
  fs.rmSync(backupsDir(), { recursive: true, force: true });
  const volumes = path.resolve(currentVolumeRoots().containerDataRoot, "volumes");
  assert.equal(path.dirname(volumes), path.resolve(currentVolumeRoots().containerDataRoot));
  fs.rmSync(volumes, { recursive: true, force: true });
  cancelRestore();
});
afterEach(() => {
  Object.assign(fullDeps, originalFull);
  Object.assign(restoreDeps, originalRestore);
  closeDatabase();
  Object.assign(config, originalPaths);
});
after(() => closeDatabase());

async function until<T>(read: () => T | null | Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a full backup stops each project only while it is copied, and restores on another instance with its data, route, branch and commit", async () => {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO projects (name, source_type, internal_port, paused, auto_deploy_branch, github_repo) VALUES ('Shop','github', 3000, 0, 'main', 'owner/shop')").run().lastInsertRowid);
  const sealed = sealEnvVariables([{ key: "DB_PASSWORD", value: "s3cret-value" }]);
  db.prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc) VALUES (?, '.env', ?, ?)").run(id, sealed.json, sealed.enc);
  db.prepare("INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port) VALUES (?, 'shop.example.com', 1, 'web', 3000)").run(id);
  db.prepare("INSERT INTO project_deployments (project_id, commit_sha, branch, status) VALUES (?, 'abc1234def', 'v2', 'active')").run(id);
  addManagedDomain("example.com");
  const previewBranch = createBranchDeployment(id, { branch: "feature/preview", env: "shared" });
  const roots = currentVolumeRoots();
  fs.mkdirSync(`${roots.containerDataRoot}/volumes/${id}`, { recursive: true });
  docker.volumes.set(`bind:${managedVolumesRoot(roots, id).host}`, { "db/PG_VERSION": "16", "uploads/a.png": "A" });
  const composeName = expectedComposeProjectName({ id, name: "Shop" });
  docker.running.add(composeName);
  let stops = 0;
  fullDeps.stop = async () => { stops += 1; docker.running.clear(); return { ok: true, output: "" }; };

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

  // A separate destination database and filesystem: upload, inspect, and run the
  // real offline instance restore before importing the project's archive.
  const destination = path.join(roots.containerDataRoot, "destination");
  closeDatabase();
  Object.assign(config, {
    sqlitePath: path.join(destination, "stackport.sqlite"),
    deployRoot: path.join(destination, "repos"),
    scriptsDir: path.join(destination, "scripts"),
  });
  const { initializeDatabase } = await import("../src/config/database");
  const target = initializeDatabase();
  target.prepare("INSERT INTO projects (name, source_type) VALUES ('Old target project', 'upload')").run();
  const uploaded = await receiveUpload(fs.createReadStream(file.path), file.size);
  assert.equal(uploaded.size, file.size);
  await assert.rejects(() => inspectFull("not the passphrase"), /./);
  const preview = await inspectFull(PASS, target);
  assert.deepEqual((await inspectFull(PASS, target)).projects, preview.projects, "a reloaded preview can recheck the uploaded archive");
  assert.deepEqual(preview.projects.map((p) => [p.name, p.hostnames, p.wasRunning]), [["Shop", ["shop.example.com"], true], [previewBranch.name, ["shop-feature-preview.example.com"], false]]);
  assert.equal(preview.current.projects, 1);

  await assert.rejects(() => confirmFull({ passphrase: PASS, mode: "recover", confirm: "wrong name" }, target), /Type the name/);
  const launched: { file: string; mode: string }[] = [];
  restoreDeps.launchHostRestore = async (hostFile, mode, hostPassphrase) => {
    launched.push({ file: hostFile, mode });
    assert.ok(hostPassphrase.endsWith("/.passphrase"));
    assert.equal(fs.readFileSync(hostPassphrase, "utf8"), PASS);
    closeDatabase();
    restoreBackup({ archivePath: hostFile, passphrase: PASS, mode: "recover", sqlitePath: config.sqlitePath, deployRoot: config.deployRoot, scriptsDir: config.scriptsDir });
    initializeDatabase();
  };
  await confirmFull({ passphrase: PASS, mode: "recover", confirm: preview.confirmName }, target);
  assert.equal(launched.length, 1);
  assert.match(launched[0].file, /restore\/parts\/parts\/instance\.spbackup$/);
  assert.equal(readPlan()?.projects.length, 2);

  const restoredDb = getDatabase();
  assert.equal((restoredDb.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 0, "the level-1 restore replaced B's old project records");
  docker.volumes.clear();
  docker.running.clear();
  const deploys: { branch: string | null; commit: string | null }[] = [];
  restoreDeps.deploy = async (_id, branch, commit) => { deploys.push({ branch, commit }); docker.running.add("restored"); return { ok: true, output: "" }; };
  const issued: string[] = [];
  restoreDeps.issueSsl = async (_id, domain) => { issued.push(domain); return { ok: true, output: "" }; };

  await assert.rejects(() => finishProjects("", restoredDb), /passphrase/);
  await finishProjects(PASS, restoredDb);
  await until(() => (readPlan() === null ? true : null), "the restore to finish");
  const copy = restoredDb.prepare("SELECT id, name, paused FROM projects WHERE branch_parent_id IS NULL").get() as { id: number; name: string; paused: number };
  assert.equal(copy.name, "Shop");
  assert.equal(copy.paused, 0, "it was running, so it runs");
  assert.deepEqual(deploys, [{ branch: "v2", commit: "abc1234def" }], "the branch and commit that ran");
  const domain = restoredDb.prepare("SELECT domain, service, container_port, use_ssl FROM project_domains WHERE project_id = ?").get(copy.id) as { domain: string; service: string; container_port: number; use_ssl: number };
  assert.deepEqual({ ...domain }, { domain: "shop.example.com", service: "web", container_port: 3000, use_ssl: 0 });
  assert.ok(issued.includes("shop.example.com"), "the certificate is asked for the hostname that served TLS");
  assert.deepEqual(docker.volumes.get(`bind:${managedVolumesRoot(currentVolumeRoots(), copy.id).host}`), { "db/PG_VERSION": "16", "uploads/a.png": "A" }, "the data is back on B, verified");
  const { tryReadEnvVariables } = await import("../src/modules/projects/envFiles");
  const env = restoredDb.prepare("SELECT * FROM project_env_files WHERE project_id = ?").get(copy.id) as Parameters<typeof tryReadEnvVariables>[0];
  assert.equal(tryReadEnvVariables(env)?.[0]?.value, "s3cret-value", "the restored environment secret decrypts");
  const [restoredBranch] = listBranchDeployments(copy.id);
  assert.equal(restoredBranch.autoDeployBranch, "feature/preview");
  assert.equal(restoredBranch.branchShareEnv, true);
  assert.equal(listProjectEnvFiles(restoredBranch.id)[0].projectId, copy.id);
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

test("a running project originally paused regains its pause, and a stopped project is not started", async () => {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const runningId = Number(db.prepare("INSERT INTO projects (name, source_type, paused) VALUES ('Paused running','github', 1)").run().lastInsertRowid);
  const stoppedId = Number(db.prepare("INSERT INTO projects (name, source_type, paused) VALUES ('Stopped','github', 0)").run().lastInsertRowid);
  const runningName = expectedComposeProjectName({ id: runningId, name: "Paused running" });
  docker.running.add(runningName);
  fullDeps.stop = async () => { docker.running.clear(); return { ok: true, output: "" }; };
  const start = fullDeps.start;
  const starts: number[] = [];
  fullDeps.start = async (id) => { starts.push(id); return start(id); };

  const job = await startFullBackup(PASS, db);
  const done = await until(() => { const v = getFullBackup(job.id, db); return v && v.state !== "running" ? v : null; }, "the backup");
  assert.equal(done.state, "done", done.error ?? "");
  assert.deepEqual(starts, [runningId]);
  assert.ok(docker.running.has(runningName));
  assert.equal(getProjectById(runningId)?.paused, true);
  assert.equal(getProjectById(stoppedId)?.paused, false);
});

test("a backup remains running until the last project's recovery finishes", async () => {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO projects (name, source_type) VALUES ('Shop','github')").run().lastInsertRowid);
  docker.running.add(expectedComposeProjectName({ id, name: "Shop" }));
  fullDeps.stop = async () => { docker.running.clear(); return { ok: true, output: "" }; };
  const start = fullDeps.start;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let recovering = false;
  fullDeps.start = async (projectId) => { recovering = true; await blocked; return start(projectId); };

  const job = await startFullBackup(PASS, db);
  try {
    await until(() => recovering || null, "recovery to start");
    assert.equal(getFullBackup(job.id, db)?.state, "running");
    assert.equal(fullBackupFile(job.id, db), null);
    assert.equal(actionRegistry.get(projectRepoKey(id))?.status, "running");
  } finally { release(); }
  const done = await until(() => { const v = getFullBackup(job.id, db); return v && v.state !== "running" ? v : null; }, "recovery to finish");
  assert.equal(done.state, "done", done.error ?? "");
});

test("failed recovery stops the backup, survives cleanup, and is retried without losing the original state", async () => {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO projects (name, source_type) VALUES ('Shop','github')").run().lastInsertRowid);
  const next = Number(db.prepare("INSERT INTO projects (name, source_type) VALUES ('Next','github')").run().lastInsertRowid);
  const name = expectedComposeProjectName({ id, name: "Shop" });
  const nextName = expectedComposeProjectName({ id: next, name: "Next" });
  docker.running.add(name);
  docker.running.add(nextName);
  const stopped: number[] = [];
  fullDeps.stop = async (projectId) => { stopped.push(projectId); docker.running.delete(name); return { ok: true, output: "" }; };
  const start = fullDeps.start;
  fullDeps.start = async () => ({ ok: false, output: "Docker could not start the container" });

  const job = await startFullBackup(PASS, db);
  const failed = await until(() => { const v = getFullBackup(job.id, db); return v && v.state === "failed" ? v : null; }, "the recovery failure");
  assert.match(failed.error ?? "", /Docker could not start/);
  assert.deepEqual(stopped, [id], "do not stop more projects after recovery fails");
  assert.ok(docker.running.has(nextName));
  const pending = (): Record<string, unknown> => JSON.parse((db.prepare("SELECT quiesced_json FROM full_backups WHERE id = ?").get(job.id) as { quiesced_json: string }).quiesced_json) as Record<string, unknown>;
  assert.deepEqual(pending(), { [String(id)]: { wasRunning: true, paused: false } });
  assert.equal(getProjectById(id)?.paused, false, "the temporary pause is cleared even after a failed start");
  assert.equal(deleteFullBackup(job.id, db), false);
  await assert.rejects(() => startFullBackup(PASS, db), /awaiting recovery/);
  db.prepare("UPDATE full_backups SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
  await reconcileFullBackups(db);
  assert.deepEqual(pending(), { [String(id)]: { wasRunning: true, paused: false } });

  // A subsequent monitor tick can restore the project once Docker works again.
  fullDeps.start = start;
  await reconcileFullBackups(db);
  assert.ok(docker.running.has(name));
  assert.deepEqual(pending(), {});
  assert.equal(getFullBackup(job.id, db)?.state, "failed", "a failed backup does not become a usable backup");
});

async function prepareProjectRestore() {
  const { getDatabase } = await import("../src/config/database");
  const db = getDatabase();
  const id = Number(db.prepare("INSERT INTO projects (name, source_type) VALUES ('Shop', 'github')").run().lastInsertRowid);
  docker.running.add(expectedComposeProjectName({ id, name: "Shop" }));
  fullDeps.stop = async () => { docker.running.clear(); return { ok: true, output: "" }; };
  const job = await startFullBackup(PASS, db);
  await until(() => getFullBackup(job.id, db)?.state === "done" || null, "the backup");
  const file = fullBackupFile(job.id, db);
  assert.ok(file);
  await receiveUpload(fs.createReadStream(file.path), file.size);
  const preview = await inspectFull(PASS, db);
  restoreDeps.launchHostRestore = async () => undefined;
  await confirmFull({ passphrase: PASS, mode: "recover", confirm: preview.confirmName }, db);
  db.exec("DELETE FROM projects");
  return db;
}

async function waitForRestore() {
  return until(async () => {
    const status = await restoreStatus();
    return status.finish && !status.finish.running ? status.finish : null;
  }, "the project restore");
}

for (const throws of [false, true]) {
  test(`a destination start ${throws ? "exception" : "failure"} keeps verified data and resumes without importing twice`, async () => {
    const db = await prepareProjectRestore();
    restoreDeps.deploy = async () => {
      if (throws) throw new Error("destination disk unavailable");
      return { ok: false, output: "destination disk unavailable" };
    };
    await finishProjects(PASS, db);
    const failed = await waitForRestore();
    assert.equal(failed.outcomes[0]?.state, "failed");
    assert.match(failed.outcomes[0]?.message ?? "", /destination disk unavailable/);
    const plan = readPlan();
    assert.ok(plan?.projects[0]?.imported);
    const importedId = plan.projects[0].imported.projectId;
    assert.equal(getProjectById(importedId)?.paused, true);
    assert.ok(fs.existsSync(path.join(currentVolumeRoots().containerDataRoot, "restore", "parts", "parts", plan.projects[0].file)));

    restoreDeps.deploy = async (projectId) => { assert.equal(projectId, importedId); return { ok: true, output: "" }; };
    await finishProjects(PASS, db);
    const finished = await waitForRestore();
    assert.equal(finished.outcomes[0]?.state, "done", finished.outcomes[0]?.message ?? "");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 1);
    assert.equal(readPlan(), null);
  });
}

test("a routing failure keeps the restore resumable without deploying completed projects again", async () => {
  const db = await prepareProjectRestore();
  let deploys = 0;
  restoreDeps.deploy = async () => { deploys += 1; return { ok: true, output: "" }; };
  restoreDeps.publish = async () => { throw new Error("nginx config rejected"); };
  await finishProjects(PASS, db);
  const failed = await waitForRestore();
  assert.equal(failed.outcomes[0]?.state, "failed");
  assert.match(failed.outcomes[0]?.message ?? "", /routing failed/);
  assert.equal(readPlan()?.projects[0]?.completed, true);
  restoreDeps.publish = async () => undefined;
  await finishProjects(PASS, db);
  const finished = await waitForRestore();
  assert.equal(finished.outcomes[0]?.state, "done");
  assert.equal(deploys, 1);
  assert.equal(readPlan(), null);
});

test("a missing project archive is a failed restore, never an already-restored project", async () => {
  const db = await prepareProjectRestore();
  const plan = readPlan();
  assert.ok(plan?.projects[0]);
  fs.rmSync(path.join(currentVolumeRoots().containerDataRoot, "restore", "parts", "parts", plan.projects[0].file));
  await finishProjects(PASS, db);
  const failed = await waitForRestore();
  assert.equal(failed.outcomes[0]?.state, "failed");
  assert.match(failed.outcomes[0]?.message ?? "", /archive is missing/);
  assert.ok(readPlan());
});
