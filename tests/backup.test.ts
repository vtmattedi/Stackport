import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { ArchiveError, ArchiveWriter, readArchive, readEntryBuffer, writeEntryTo } from "../src/modules/backup/archive";
import { TABLE_TIERS } from "../src/modules/backup/classification";
import { createBackup } from "../src/modules/backup/export";
import { ensureInstanceIdentity } from "../src/modules/backup/instance";
import { restoreBackup, RestoreRefused, stageArchive, verifyStaged } from "../src/modules/backup/restore";
import { createKeyring } from "../src/shared/crypto";

const PASS = "correct horse battery staple";
const ENV = { JWT_SECRET: "jwt-src", ENCRYPTION_KEY: "enc-src", WEBHOOK_SECRET: "wh-src", STACKPORT_DOMAIN: "src.example.com" } as NodeJS.ProcessEnv;
const ring = createKeyring({ jwtSecret: "jwt-src", encryptionKey: "enc-src" });

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stackport-backup-"));
}

/** A source installation: an admin, a credential, a project with an env file, a domain, an upload dir and a webhook script. */
function seed(): { scripts: string; repos: string; dir: string } {
  const db = initializeDatabase();
  // The test database file lives for the whole process: start every scenario from an empty installation.
  for (const table of ["project_domains", "project_env_files", "projects", "credentials", "auth_tokens", "api_tokens", "notification_logs", "github_poller_config"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM sqlite_sequence");
  ensureInstanceIdentity(db);
  db.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('admin_password_hash','$2a$bcrypt-hash')").run();
  db.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('push_worker_poll_at','runtime-heartbeat')").run();
  db.prepare("INSERT INTO credentials (type,alias,secret_enc) VALUES ('github','gh',?)").run(ring.encrypt("ghp_secret"));
  db.prepare("INSERT INTO projects (name,source_type,hook_secret_enc,auto_deploy_branch,health_check_interval_s) VALUES ('Shop','upload',?, 'main', 60)").run(ring.encrypt("hook"));
  db.prepare("INSERT INTO project_env_files (project_id,relative_path,variables_json,variables_enc) VALUES (1,'.env','{}',?)").run(ring.encrypt('{"DB_PASSWORD":"s3cret"}'));
  db.prepare("INSERT INTO project_domains (project_id,domain) VALUES (1,'shop.example.com')").run();
  db.prepare("INSERT INTO auth_tokens (id,username,expires_at) VALUES ('sess','admin','2999-01-01')").run();
  db.prepare("INSERT INTO api_tokens (name,token_hash,prefix) VALUES ('ci','hash','sp_')").run();
  db.prepare("INSERT INTO notification_logs (subject) VALUES ('old mail')").run();
  const dir = tmp();
  const scripts = path.join(dir, "scripts");
  const repos = path.join(dir, "repos");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "deploy.sh"), "#!/bin/sh\necho hi\n");
  const repo = path.join(repos, "1-shop");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(repo, "sub", "app.conf"), "x");
  return { scripts, repos, dir };
}

function backup(level: 1 | 2, paths: ReturnType<typeof seed>, file = path.join(paths.dir, `b${level}.spbackup`)): string {
  createBackup({ level, outPath: file, passphrase: PASS, env: ENV, scriptsDir: paths.scripts, deployRoot: paths.repos });
  return file;
}

function sqliteRows(file: string, sql: string): unknown[] {
  const db = new Database(file, { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

test("every table in the schema is classified, so none can reach a level by omission", () => {
  const db = initializeDatabase();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const unknown = tables.filter((name) => !(name in TABLE_TIERS));
  assert.deepEqual(unknown, [], "classify new tables in src/modules/backup/classification.ts");
  assert.deepEqual(Object.keys(TABLE_TIERS).filter((name) => !tables.includes(name)), [], "classification names a table that no longer exists");
  closeDatabase();
});

test("archive: round-trips entries, and a wrong passphrase, a flipped byte and a truncated file all fail", () => {
  const dir = tmp();
  const file = path.join(dir, "a.spbackup");
  const writer = new ArchiveWriter(file, PASS);
  const big = Buffer.alloc(200_000, 7);
  writer.addBuffer("manifest.json", Buffer.from("{}"));
  writer.addBuffer("big.bin", big);
  writer.finish();

  const got: Record<string, number> = {};
  readArchive(file, PASS, (entry) => { got[entry.name] = readEntryBuffer(entry, 1_000_000).length; });
  assert.deepEqual(got, { "manifest.json": 2, "big.bin": 200_000 });

  assert.throws(() => readArchive(file, "wrong", () => undefined), (e: ArchiveError) => e.code === "wrong-passphrase-or-corrupt");

  const bytes = fs.readFileSync(file);
  const flipped = Buffer.from(bytes);
  flipped[bytes.length - 40] ^= 1;
  fs.writeFileSync(path.join(dir, "flip"), flipped);
  assert.throws(() => readArchive(path.join(dir, "flip"), PASS, (e) => { readEntryBuffer(e, 1_000_000); }), ArchiveError);

  fs.writeFileSync(path.join(dir, "cut"), bytes.subarray(0, bytes.length - 30));
  assert.throws(() => readArchive(path.join(dir, "cut"), PASS, (e) => { readEntryBuffer(e, 1_000_000); }), ArchiveError);

  // Dropping the whole final chunk (a clean chunk boundary) must not read as a shorter, valid archive.
  const cut2 = (() => {
    // Walk the chunk frames to find where the last one starts.
    let offset = 8 + 1 + 16 + 1 + 4;
    let lastStart = offset;
    while (offset < bytes.length) { lastStart = offset; offset += 4 + 1 + bytes.readUInt32BE(offset) + 16; }
    return bytes.subarray(0, lastStart);
  })();
  fs.writeFileSync(path.join(dir, "dropped"), cut2);
  assert.throws(() => readArchive(path.join(dir, "dropped"), PASS, (e) => { readEntryBuffer(e, 1_000_000); }), (e: ArchiveError) => e.code === "truncated");
});

test("archive: entries that conflict (a file and a directory of the same name) are a malformed archive, not a crash", () => {
  const dir = tmp();
  const file = path.join(dir, "conflict.spbackup");
  const writer = new ArchiveWriter(file, PASS);
  writer.addBuffer("files/x", Buffer.from("a file"));
  writer.addBuffer("files/x/y", Buffer.from("under it"));
  writer.finish();
  const out = path.join(dir, "out");
  assert.throws(() => readArchive(file, PASS, (entry) => { writeEntryTo(entry, out); }), (e: unknown) => e instanceof ArchiveError && e.code === "malformed");
});

test("archive: refuses entry names that could escape the extraction directory", () => {
  const writer = new ArchiveWriter(path.join(tmp(), "x.spbackup"), PASS);
  for (const name of ["../x", "/etc/passwd", "a/../../b", "C:\\x", "a\\b", ""]) {
    assert.throws(() => writer.addBuffer(name, Buffer.from("x")), (e: ArchiveError) => e.code === "unsafe-path", name);
  }
});

test("level 1 holds settings and credentials but no project, session or runtime data", () => {
  const paths = seed();
  const file = backup(1, paths);
  const scratch = path.join(paths.dir, "s1");
  const staged = stageArchive(file, PASS, scratch);
  const db = path.join(scratch, "db.sqlite");

  assert.equal(staged.manifest.level, 1);
  assert.equal((sqliteRows(db, "SELECT COUNT(*) AS n FROM credentials")[0] as { n: number }).n, 1);
  for (const table of ["projects", "project_env_files", "project_domains", "auth_tokens", "notification_logs"]) {
    assert.equal((sqliteRows(db, `SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n, 0, table);
  }
  assert.equal(sqliteRows(db, "SELECT value FROM app_meta WHERE key='push_worker_poll_at'").length, 0, "runtime meta rows are dropped");
  assert.ok(sqliteRows(db, "SELECT value FROM app_meta WHERE key='admin_password_hash'").length === 1);
  assert.ok(!staged.manifest.entries.some((e) => e.name.startsWith("files/repos/")));
  assert.ok(staged.manifest.components.find((c) => c.id === "projects" && !c.included));
  assert.ok(staged.manifest.components.find((c) => c.id === "project-data" && !c.included), "workload data is stated as not covered");
  assert.deepEqual(verifyStaged(staged).filter((f) => f.level === "error"), []);
  // Dropped rows must not linger in the file's free pages.
  assert.ok(!fs.readFileSync(db).includes(Buffer.from("shop.example.com")));
  assert.ok(!fs.readFileSync(db).includes(Buffer.from("old mail")));
  closeDatabase();
});

test("level 2 adds projects, managed env values, domains and uploaded files", () => {
  const paths = seed();
  const file = backup(2, paths);
  const scratch = path.join(paths.dir, "s2");
  const staged = stageArchive(file, PASS, scratch);
  const db = path.join(scratch, "db.sqlite");

  assert.equal((sqliteRows(db, "SELECT COUNT(*) AS n FROM projects")[0] as { n: number }).n, 1);
  const env = sqliteRows(db, "SELECT variables_enc FROM project_env_files")[0] as { variables_enc: string };
  assert.equal(ring.decrypt(env.variables_enc), '{"DB_PASSWORD":"s3cret"}', "secret values travel, still encrypted at the field level");
  assert.equal((sqliteRows(db, "SELECT COUNT(*) AS n FROM auth_tokens")[0] as { n: number }).n, 0);
  assert.ok(staged.manifest.entries.some((e) => e.name === "files/repos/1-shop/sub/app.conf"));
  assert.ok(staged.manifest.entries.some((e) => e.name === "files/scripts/deploy.sh"));
  assert.equal(staged.env.secrets["ENCRYPTION_KEY"], "enc-src");
  assert.equal(staged.env.host["STACKPORT_DOMAIN"], "src.example.com");
  assert.deepEqual(verifyStaged(staged).filter((f) => f.level === "error"), []);
  closeDatabase();
});

function target(): { sqlite: string; scripts: string; repos: string; env: string; dir: string } {
  const dir = tmp();
  return { dir, sqlite: path.join(dir, "data", "stackport.sqlite"), scripts: path.join(dir, "data", "scripts"), repos: path.join(dir, "data", "repos"), env: path.join(dir, "data", ".restore-secrets.env") };
}

test("recover: restores into an empty target keeping the instance id, password hash, secrets and files", () => {
  const paths = seed();
  const source = ensureInstanceIdentity(getDatabase());
  const file = backup(2, paths);
  closeDatabase();

  const t = target();
  const result = restoreBackup({ archivePath: file, passphrase: PASS, mode: "recover", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env });
  assert.equal(result.instanceId, source.id);

  const db = new Database(t.sqlite, { readonly: true });
  try {
    assert.equal((db.prepare("SELECT value FROM app_meta WHERE key='admin_password_hash'").get() as { value: string }).value, "$2a$bcrypt-hash");
    assert.equal(ring.decrypt((db.prepare("SELECT secret_enc FROM credentials").get() as { secret_enc: string }).secret_enc), "ghp_secret");
    assert.equal((db.prepare("SELECT paused FROM projects").get() as { paused: number }).paused, 0, "recover leaves projects as they were");
  } finally { db.close(); }
  assert.equal(fs.readFileSync(path.join(t.repos, "1-shop", "sub", "app.conf"), "utf8"), "x");
  assert.equal(fs.readFileSync(path.join(t.scripts, "deploy.sh"), "utf8").includes("echo hi"), true);
  const handoff = fs.readFileSync(t.env, "utf8").trim().split("\n");
  assert.deepEqual(handoff.sort(), ["ENCRYPTION_KEY=enc-src", "JWT_SECRET=jwt-src", "WEBHOOK_SECRET=wh-src"], "only the secrets, as KEY=VALUE lines for the host to merge");
  if (process.platform !== "win32") assert.equal(fs.statSync(t.env).mode & 0o777, 0o600);
  assert.ok(result.secretsToAdopt.includes("ENCRYPTION_KEY"), "the host is told which keys differ");
  assert.equal(fs.readdirSync(t.dir).filter((n) => n.startsWith(".restore-staging")).length, 0);
});

test("clone: new instance id, no sessions/tokens/GitHub App, projects paused and detached, automation off", () => {
  const paths = seed();
  const db = getDatabase();
  db.prepare("INSERT INTO github_poller_config (id,enabled) VALUES (1,1)").run();
  db.prepare("UPDATE projects SET github_hook_id = 99, hook_public_id = 'pub'").run();
  const source = ensureInstanceIdentity(db);
  const file = backup(2, paths);
  closeDatabase();

  const t = target();
  const result = restoreBackup({ archivePath: file, passphrase: PASS, mode: "clone", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env });
  assert.notEqual(result.instanceId, source.id);
  const clone = new Database(t.sqlite, { readonly: true });
  try {
    assert.equal((clone.prepare("SELECT value FROM app_meta WHERE key='instance_id'").get() as { value: string }).value, result.instanceId);
    assert.equal((clone.prepare("SELECT value FROM app_meta WHERE key='instance_name'").get() as { value: string }).value, source.name, "the display name may be the same");
    assert.equal((clone.prepare("SELECT COUNT(*) AS n FROM api_tokens").get() as { n: number }).n, 0);
    assert.equal((clone.prepare("SELECT enabled FROM github_poller_config").get() as { enabled: number }).enabled, 0);
    const project = clone.prepare("SELECT paused, health_check_interval_s, auto_deploy_branch, github_hook_id, hook_public_id FROM projects").get() as Record<string, unknown>;
    assert.deepEqual(project, { paused: 1, health_check_interval_s: 0, auto_deploy_branch: null, github_hook_id: null, hook_public_id: null });
    assert.equal(ring.decrypt((clone.prepare("SELECT secret_enc FROM credentials").get() as { secret_enc: string }).secret_enc), "ghp_secret", "credentials stay decryptable");
  } finally { clone.close(); }
});

test("clone: turns the public domain and the original's VM monitoring off", () => {
  const paths = seed();
  const db = getDatabase();
  db.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('nginx_app_domain','stack.example.com')").run();
  db.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('nginx_app_enabled','1')").run();
  db.prepare("INSERT INTO vps_providers (id,type,name) VALUES (1,'linode','p')").run();
  db.prepare("INSERT INTO vps_monitored_vms (provider_id,vm_id) VALUES (1,'vm1')").run();
  const file = backup(2, paths);
  db.exec("DELETE FROM vps_monitored_vms; DELETE FROM vps_providers");
  closeDatabase();

  const t = target();
  restoreBackup({ archivePath: file, passphrase: PASS, mode: "clone", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env });
  const clone = new Database(t.sqlite, { readonly: true });
  try {
    assert.equal((clone.prepare("SELECT value FROM app_meta WHERE key='nginx_app_enabled'").get() as { value: string }).value, "0");
    assert.equal(clone.prepare("SELECT value FROM app_meta WHERE key='nginx_app_domain'").get(), undefined);
    assert.equal((clone.prepare("SELECT COUNT(*) AS n FROM vps_monitored_vms").get() as { n: number }).n, 0);
  } finally { clone.close(); }
});

test("restoring an archive without scripts sets the host's webhook scripts aside, and a stale handoff is never kept", () => {
  const paths = seed();
  fs.rmSync(paths.scripts, { recursive: true, force: true }); // the source had no scripts
  const file = backup(2, paths);
  closeDatabase();

  const t = target();
  fs.mkdirSync(t.scripts, { recursive: true });
  fs.writeFileSync(path.join(t.scripts, "host.sh"), "host");
  fs.mkdirSync(path.dirname(t.env), { recursive: true });
  fs.writeFileSync(t.env, "JWT_SECRET=stale-from-another-archive\n");
  restoreBackup({ archivePath: file, passphrase: PASS, mode: "recover", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env });
  assert.equal(fs.existsSync(path.join(t.scripts, "host.sh")), false, "the host's script must not stay runnable");
  assert.ok(fs.readFileSync(t.env, "utf8").includes("JWT_SECRET=jwt-src"));
  assert.ok(!fs.readFileSync(t.env, "utf8").includes("stale"));
});

test("a failed restore removes the handoff file it wrote", () => {
  const paths = seed();
  const file = backup(2, paths);
  closeDatabase();
  const t = target();
  fs.mkdirSync(path.dirname(t.env), { recursive: true });
  fs.writeFileSync(t.env, "JWT_SECRET=stale\n");
  assert.throws(() => restoreBackup({ archivePath: file, passphrase: "wrong passphrase!!", mode: "recover", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env }), RestoreRefused);
  assert.equal(fs.existsSync(t.env), false);
});

test("archive: a buffer much larger than one chunk round-trips", () => {
  const dir = tmp();
  const file = path.join(dir, "big.spbackup");
  const big = Buffer.alloc(5 * 1024 * 1024 + 123, 7);
  const writer = new ArchiveWriter(file, PASS);
  writer.addBuffer("big.bin", big);
  writer.finish();
  let got: Buffer | null = null;
  readArchive(file, PASS, (entry) => { got = readEntryBuffer(entry, 8 * 1024 * 1024); });
  assert.ok(got !== null && (got as Buffer).equals(big));
});

test("restore replaces an existing installation but keeps its database and directories aside", () => {
  const paths = seed();
  const file = backup(2, paths);
  closeDatabase();

  const t = target();
  fs.mkdirSync(path.dirname(t.sqlite), { recursive: true });
  const old = new Database(t.sqlite);
  old.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('previous install')");
  old.close();
  fs.mkdirSync(t.scripts, { recursive: true });
  fs.writeFileSync(path.join(t.scripts, "old.sh"), "old");

  const result = restoreBackup({ archivePath: file, passphrase: PASS, mode: "recover", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env });
  assert.ok(result.preRestoreDir);
  const kept = new Database(path.join(result.preRestoreDir as string, "stackport.sqlite"), { readonly: true });
  assert.equal((kept.prepare("SELECT v FROM marker").get() as { v: string }).v, "previous install");
  kept.close();
  assert.equal(fs.existsSync(path.join(t.scripts, "old.sh")), false);
  assert.ok(fs.readdirSync(result.preRestoreDir as string).some((n) => n.startsWith("files-")));
});

test("invalid archives are refused and leave the existing installation untouched", () => {
  const paths = seed();
  const good = backup(2, paths);
  closeDatabase();
  const t = target();
  fs.mkdirSync(path.dirname(t.sqlite), { recursive: true });
  fs.writeFileSync(t.sqlite, "existing database bytes");

  const run = (file: string, passphrase = PASS): void => { restoreBackup({ archivePath: file, passphrase, mode: "recover", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env }); };
  assert.throws(() => run(good, "nope"), RestoreRefused);

  const bytes = fs.readFileSync(good);
  const damaged = path.join(t.dir, "damaged.spbackup");
  fs.writeFileSync(damaged, bytes.subarray(0, bytes.length - 100));
  assert.throws(() => run(damaged), RestoreRefused);

  const garbage = path.join(t.dir, "garbage.spbackup");
  fs.writeFileSync(garbage, "not an archive at all, just text.");
  assert.throws(() => run(garbage), RestoreRefused);

  assert.equal(fs.readFileSync(t.sqlite, "utf8"), "existing database bytes");
  assert.equal(fs.existsSync(t.env), false);
});

test("an archive whose stored secrets cannot be decrypted by its own keys is refused", () => {
  const paths = seed();
  const file = path.join(paths.dir, "wrongkeys.spbackup");
  // JWT and encryption keys that do not match the ciphertext written by `ring`.
  createBackup({ level: 2, outPath: file, passphrase: PASS, env: { ...ENV, ENCRYPTION_KEY: "some-other-key" } as NodeJS.ProcessEnv, scriptsDir: paths.scripts, deployRoot: paths.repos });
  closeDatabase();
  const t = target();
  assert.throws(
    () => restoreBackup({ archivePath: file, passphrase: PASS, mode: "recover", sqlitePath: t.sqlite, scriptsDir: t.scripts, deployRoot: t.repos, envOutPath: t.env }),
    (e: RestoreRefused) => e.findings.some((f) => /cannot be decrypted/.test(f.message))
  );
  assert.equal(fs.existsSync(t.sqlite), false, "nothing was applied");
});

test("an archive from a newer schema is refused with an instruction to update", () => {
  const paths = seed();
  const file = backup(1, paths);
  closeDatabase();
  const staged = stageArchive(file, PASS, path.join(paths.dir, "newer"));
  const findings = verifyStaged(staged, { latestSchema: staged.manifest.schemaVersion - 1 });
  assert.ok(findings.some((f) => f.level === "error" && /newer Stackport/.test(f.message)));
});

test("ensureInstanceIdentity is created once and stable across calls", () => {
  const db = initializeDatabase();
  const first = ensureInstanceIdentity(db);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(ensureInstanceIdentity(db), first);
  closeDatabase();
});

test("an archive carrying a secret the host file cannot hold safely is refused", () => {
  const paths = seed();
  const file = path.join(paths.dir, "unsafe.spbackup");
  createBackup({ level: 1, outPath: file, passphrase: PASS, env: { ...ENV, WEBHOOK_SECRET: "has space|and/slash" } as NodeJS.ProcessEnv, scriptsDir: paths.scripts, deployRoot: paths.repos });
  closeDatabase();
  const staged = stageArchive(file, PASS, path.join(paths.dir, "unsafe"));
  assert.ok(verifyStaged(staged).some((f) => f.level === "error" && /WEBHOOK_SECRET/.test(f.message)));
});
