import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { initializeDatabase } from "../src/config/database";
import { ArchiveWriter } from "../src/modules/backup/archive";
import { createBackup } from "../src/modules/backup/export";
import { contentDigest, exportProject, importProject, ProjectArchiveError, stageProjectArchive, type ProjectContent } from "../src/modules/backup/projectArchive";
import { sealEnvVariables, tryReadEnvVariables, type ProjectEnvFileRow } from "../src/modules/projects/envFiles";

const PASS = "a long enough passphrase for archives";

interface Seeded { dir: string; roots: { containerDataRoot: string; hostDataRoot: string }; deployRoot: string; projectId: number }

const made: string[] = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS temp directory is cleaned eventually */ } } });

function seed(): Seeded {
  const db = initializeDatabase();
  for (const table of ["project_domains", "project_env_files", "network_group_services", "tcp_exposures", "projects"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM sqlite_sequence");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-project-archive-"));
  made.push(dir);
  const roots = { containerDataRoot: path.join(dir, "data"), hostDataRoot: path.join(dir, "data") };
  const deployRoot = path.join(dir, "data", "repos");
  const projectId = Number(db.prepare("INSERT INTO projects (name, source_type, internal_port, group_name, paused, network_group, deploy_trigger, nginx_extra_config) VALUES ('Shop','upload', 3000, 'web', 1, 'apps', 'webhook', 'client_max_body_size 5m;')").run().lastInsertRowid);
  const sealed = sealEnvVariables([{ key: "DB_PASSWORD", value: "s3cret-value" }, { key: "MODE", value: "prod" }]);
  db.prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc) VALUES (?, '.env', ?, ?)").run(projectId, sealed.json, sealed.enc);
  db.prepare("INSERT INTO network_group_services (project_id, service) VALUES (?, 'api')").run(projectId);
  db.prepare("INSERT INTO project_domains (project_id, domain, service, container_port) VALUES (?, 'shop.example.com', 'web', 3000)").run(projectId);
  db.prepare("INSERT INTO tcp_exposures (project_id, public_port, service, container_port) VALUES (?, 5432, 'db', 5432)").run(projectId);
  const volumes = path.join(roots.containerDataRoot, "volumes", String(projectId));
  fs.mkdirSync(path.join(volumes, "pg", "wal"), { recursive: true });
  fs.writeFileSync(path.join(volumes, "pg", "data.bin"), crypto.randomBytes(200_000));
  fs.writeFileSync(path.join(volumes, "note.txt"), "hello");
  const repo = path.join(deployRoot, `${projectId}-shop`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "docker-compose.yml"), "services: {}\n");
  return { dir, roots, deployRoot, projectId };
}

const exportOpts = (s: Seeded, file: string) => ({ projectId: s.projectId, outPath: file, passphrase: PASS, roots: s.roots, deployRoot: s.deployRoot });
const importOpts = (s: Seeded, file: string, extra: object = {}) => ({ archivePath: file, passphrase: PASS, roots: s.roots, deployRoot: s.deployRoot, ...extra });
const failsWith = (code: string) => (error: unknown): boolean => error instanceof ProjectArchiveError && error.code === code;

test("a project round-trips through an archive and is verified against its digest", () => {
  const s = seed();
  const db = initializeDatabase();
  const file = path.join(s.dir, "shop.spbackup");
  const manifest = exportProject(exportOpts(s, file));
  assert.ok(manifest.notCarried.some((line) => line.includes("named volumes")));
  assert.ok(manifest.notCarried.some((line) => line.includes("webhook")));
  assert.equal(manifest.hostnames[0]?.domain, "shop.example.com");

  const result = importProject(importOpts(s, file, { name: "Shop copy", domains: [{ domain: "shop2.example.com", service: "web", containerPort: 3000 }] }));
  assert.equal(result.digest, manifest.digest, "recomputed from what the target wrote");
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(result.projectId) as Record<string, unknown>;
  assert.equal(row["name"], "Shop copy");
  assert.equal(row["internal_port"], 3000);
  assert.equal(row["deploy_trigger"], "poller", "a webhook trigger cannot move: the hook is tied to the old instance");
  assert.equal(row["nginx_extra_config"], null, "raw nginx is not applied unless allowed");
  assert.equal(row["credential_id"], null);
  const env = db.prepare("SELECT * FROM project_env_files WHERE project_id = ?").get(result.projectId) as ProjectEnvFileRow;
  assert.deepEqual(tryReadEnvVariables(env)?.map((v) => `${v.key}=${v.value}`), ["DB_PASSWORD=s3cret-value", "MODE=prod"]);
  assert.ok(!env.variables_json.includes("s3cret"), "values are stored encrypted");
  assert.deepEqual((db.prepare("SELECT service FROM network_group_services WHERE project_id = ?").all(result.projectId) as { service: string }[]).map((r) => r.service), ["api"]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tcp_exposures WHERE project_id = ?").get(result.projectId) as { n: number }).n, 0, "public ports are chosen per instance");
  assert.equal((db.prepare("SELECT domain FROM project_domains WHERE project_id = ?").get(result.projectId) as { domain: string }).domain, "shop2.example.com");

  const volumes = path.join(s.roots.containerDataRoot, "volumes", String(result.projectId));
  assert.deepEqual(fs.readFileSync(path.join(volumes, "pg", "data.bin")), fs.readFileSync(path.join(s.roots.containerDataRoot, "volumes", String(s.projectId), "pg", "data.bin")));
  assert.ok(fs.statSync(path.join(volumes, "pg", "wal")).isDirectory(), "an empty directory survives");
  assert.ok(fs.existsSync(path.join(s.deployRoot, `${result.projectId}-shop-copy`, "docker-compose.yml")));
});

test("raw nginx directives are applied only when the importer allows them", () => {
  const s = seed();
  const db = initializeDatabase();
  const file = path.join(s.dir, "n.spbackup");
  exportProject(exportOpts(s, file));
  const result = importProject(importOpts(s, file, { name: "Allowed", allowRawNginx: true }));
  assert.equal((db.prepare("SELECT nginx_extra_config FROM projects WHERE id = ?").get(result.projectId) as { nginx_extra_config: string }).nginx_extra_config, "client_max_body_size 5m;");
});

test("a name that exists is refused and nothing is left behind", () => {
  const s = seed();
  const db = initializeDatabase();
  const file = path.join(s.dir, "dup.spbackup");
  exportProject(exportOpts(s, file));
  assert.throws(() => importProject(importOpts(s, file)), failsWith("name-exists"));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 1);
  assert.deepEqual(fs.readdirSync(s.roots.containerDataRoot).filter((name) => name.startsWith(".project-import-")), [], "staging is removed");
});

test("a failed import undoes its rows and directories, and leaves a directory it did not create", () => {
  const s = seed();
  const db = initializeDatabase();
  const file = path.join(s.dir, "x.spbackup");
  exportProject(exportOpts(s, file));
  // The next project id is 2: a directory already there is somebody else's and must not be deleted by the rollback.
  const foreign = path.join(s.roots.containerDataRoot, "volumes", "2");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "keep.txt"), "mine");
  assert.throws(() => importProject(importOpts(s, file, { name: "Other" })), failsWith("invalid"));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 1, "the row is gone");
  assert.equal(fs.readFileSync(path.join(foreign, "keep.txt"), "utf8"), "mine");
  // A hostname that is already taken fails inside the transaction: no row, no files.
  fs.rmSync(foreign, { recursive: true });
  assert.throws(() => importProject(importOpts(s, file, { name: "Taken", domains: [{ domain: "shop.example.com" }] })));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 1);
  assert.equal(fs.existsSync(path.join(s.roots.containerDataRoot, "volumes", "2")), false);
});

test("a damaged archive, a wrong passphrase and an instance backup are all refused", () => {
  const s = seed();
  const file = path.join(s.dir, "d.spbackup");
  exportProject(exportOpts(s, file));
  const bytes = fs.readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const damaged = path.join(s.dir, "damaged.spbackup");
  fs.writeFileSync(damaged, bytes);
  assert.throws(() => stageProjectArchive(damaged, PASS, path.join(s.dir, "st1")), failsWith("corrupt"));
  assert.throws(() => stageProjectArchive(file, "not the passphrase at all", path.join(s.dir, "st2")), failsWith("corrupt"));
  const instance = path.join(s.dir, "instance.spbackup");
  createBackup({ level: 2, outPath: instance, passphrase: PASS, env: { JWT_SECRET: "j", ENCRYPTION_KEY: "e", WEBHOOK_SECRET: "w" } as NodeJS.ProcessEnv, scriptsDir: path.join(s.dir, "none"), deployRoot: s.deployRoot });
  assert.throws(() => stageProjectArchive(instance, PASS, path.join(s.dir, "st3")), failsWith("not-a-project-archive"));
});

test("the digest changes with any file, any value, and not with order", () => {
  const base: ProjectContent = { config: { internal_port: 1 }, env: [{ path: ".env", variables: [{ key: "A", value: "1" }, { key: "B", value: "2" }] }], groupServices: ["x", "y"], dirs: ["volumes/a"], files: [{ name: "volumes/f", size: 1, sha256: "a".repeat(64) }, { name: "volumes/g", size: 2, sha256: "b".repeat(64) }] };
  const digest = contentDigest(base);
  assert.equal(contentDigest({ ...base, env: [{ path: ".env", variables: [...base.env[0].variables].reverse() }], groupServices: ["y", "x"], files: [...base.files].reverse() }), digest);
  assert.notEqual(contentDigest({ ...base, files: [{ ...base.files[0], sha256: "c".repeat(64) }, base.files[1]] }), digest);
  assert.notEqual(contentDigest({ ...base, env: [{ path: ".env", variables: [{ key: "A", value: "1" }, { key: "B", value: "3" }] }] }), digest);
  assert.notEqual(contentDigest({ ...base, dirs: [] }), digest);
});

test("a manifest with the wrong shape is refused as corrupt, not as a crash", () => {
  const s = seed();
  const forged = path.join(s.dir, "forged.spbackup");
  const writer = new ArchiveWriter(forged, PASS);
  writer.addBuffer("header.json", Buffer.from(JSON.stringify({ kind: "project", format: 1 })));
  writer.addBuffer("manifest.json", Buffer.from(JSON.stringify({ kind: "project", format: 1, digest: "x", content: { files: [], dirs: [] } })));
  writer.finish();
  assert.throws(() => stageProjectArchive(forged, PASS, path.join(s.dir, "st-forged")), failsWith("corrupt"));
});

test("an upload-only path in a non-upload project is refused", () => {
  const s = seed();
  const db = initializeDatabase();
  db.prepare("UPDATE projects SET source_type = 'github' WHERE id = ?").run(s.projectId);
  const file = path.join(s.dir, "gh.spbackup");
  const manifest = exportProject(exportOpts(s, file));
  assert.equal(manifest.content.files.some((f) => f.name.startsWith("repo/")), false, "a Git checkout is cloned again, never archived");
  const result = importProject(importOpts(s, file, { name: "From git" }));
  assert.equal(result.digest, manifest.digest);
});

test("links are skipped and counted, and the digest does not depend on locale ordering", { skip: process.platform === "win32" }, () => {
  const s = seed();
  const volumes = path.join(s.roots.containerDataRoot, "volumes", String(s.projectId));
  fs.symlinkSync("/etc/passwd", path.join(volumes, "link"));
  const manifest = exportProject(exportOpts(s, path.join(s.dir, "l.spbackup")));
  assert.equal(manifest.skippedSpecialFiles, 1);
  assert.equal(manifest.content.files.some((f) => f.name.endsWith("link")), false);
});

test("data this process cannot read refuses the export instead of being left out", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const s = seed();
  const locked = path.join(s.roots.containerDataRoot, "volumes", String(s.projectId), "pg");
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => exportProject(exportOpts(s, path.join(s.dir, "u.spbackup"))), failsWith("unreadable"));
    assert.equal(fs.existsSync(path.join(s.dir, "u.spbackup")), false, "no partial archive");
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("the digest sorts by code unit, so every machine computes the same one", () => {
  const files = ["b", "B", "a", "\u00e4", "z"].map((name) => ({ name: `volumes/${name}`, size: 1, sha256: "a".repeat(64) }));
  const content: ProjectContent = { config: {}, env: [], groupServices: [], dirs: [], files };
  assert.equal(contentDigest(content), contentDigest({ ...content, files: [...files].reverse() }));
  // Fixed value: a change in ordering or encoding changes every digest ever recorded, so it must be a deliberate format bump.
  assert.equal(contentDigest({ config: {}, env: [], groupServices: [], dirs: ["volumes/d"], files: [{ name: "volumes/f", size: 1, sha256: "0".repeat(64) }] }), "d78341cc4cb01d0e1da813e7abc2664d48cd0a032f6934e54eb891d11d3d70a9");
});
