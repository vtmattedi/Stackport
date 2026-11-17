import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { initializeDatabase } from "../src/config/database";
import { exportProject, importProject, ProjectArchiveError } from "../src/modules/backup/projectArchive";
import { DockerVolumeEngine, type VolumeEngine, type VolumeSource } from "../src/modules/backup/volumeEngine";

const PASS = "a long enough passphrase for archives";
const made: string[] = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } });

/** A volume store in memory: a "tar" is the JSON of the volume's files, and the tree digest is a hash of the same. */
class FakeEngine implements VolumeEngine {
  volumes = new Map<string, Record<string, string>>();
  running: string[] = [];
  removed: string[] = [];
  dropOnImport: string | null = null;
  private key = (source: VolumeSource): string => (source.kind === "named" ? `named:${source.name}` : `bind:${source.hostPath}`);
  async runningContainers(): Promise<string[]> { return this.running; }
  async namedVolumes(composeProject: string): Promise<{ name: string; key: string }[]> {
    return [...this.volumes.keys()].filter((k) => k.startsWith(`named:${composeProject}_`)).map((k) => ({ name: k.slice(6), key: k.slice(6 + composeProject.length + 1) }));
  }
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
  async remove(source: VolumeSource): Promise<void> { this.removed.push(this.key(source)); this.volumes.delete(this.key(source)); }
}

function seed(): { dir: string; roots: { containerDataRoot: string; hostDataRoot: string }; deployRoot: string; projectId: number } {
  const db = initializeDatabase();
  for (const table of ["project_domains", "project_env_files", "network_group_services", "tcp_exposures", "projects"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM sqlite_sequence");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-project-volumes-"));
  made.push(dir);
  const roots = { containerDataRoot: path.join(dir, "data"), hostDataRoot: path.join(dir, "data") };
  const projectId = Number(db.prepare("INSERT INTO projects (name, source_type) VALUES ('Shop','github')").run().lastInsertRowid);
  fs.mkdirSync(path.join(roots.containerDataRoot, "volumes", String(projectId)), { recursive: true });
  return { dir, roots, deployRoot: path.join(dir, "data", "repos"), projectId };
}

const opts = (s: ReturnType<typeof seed>, extra: object = {}) => ({ roots: s.roots, deployRoot: s.deployRoot, passphrase: PASS, ...extra });
const hostManaged = (s: ReturnType<typeof seed>, id: number): string => path.posix.join(s.roots.hostDataRoot.replace(/\\/g, "/"), "volumes", String(id));
const failsWith = (code: string) => (error: unknown): boolean => error instanceof ProjectArchiveError && error.code === code;

test("volumes travel as helper tars, are verified by tree digest, and a stopped project is required", async () => {
  const s = seed();
  const db = initializeDatabase();
  const engine = new FakeEngine();
  engine.volumes.set(`bind:${hostManaged(s, s.projectId)}`, { "uploads/a.png": "A" });
  engine.volumes.set("named:1-shop_pgdata", { "base/1": "row1", "PG_VERSION": "16" });
  const file = path.join(s.dir, "v.spbackup");

  engine.running = ["1-shop-db-1"];
  await assert.rejects(() => exportProject({ ...opts(s), projectId: s.projectId, outPath: file, engine }), failsWith("running"));
  assert.equal(fs.existsSync(file), false);
  engine.running = [];

  const manifest = await exportProject({ ...opts(s), projectId: s.projectId, outPath: file, engine });
  assert.deepEqual((manifest.content.volumes ?? []).map((v) => v.id).sort(), ["managed", "named:pgdata"]);
  assert.equal(manifest.blobs?.length, 2);
  assert.ok(!manifest.notCarried.some((line) => line.includes("Docker named volumes")), "named volumes are carried when the helper is available");

  await assert.rejects(() => importProject({ ...opts(s), archivePath: file, name: "No helper" }), failsWith("needs-helper"));
  const result = await importProject({ ...opts(s), archivePath: file, name: "Shop copy", engine });
  assert.equal(result.digest, manifest.digest);
  assert.deepEqual(engine.volumes.get(`named:${result.projectId}-shop-copy_pgdata`), { "base/1": "row1", "PG_VERSION": "16" });
  assert.deepEqual(engine.volumes.get(`bind:${hostManaged(s, result.projectId)}`), { "uploads/a.png": "A" });
  assert.equal((db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 2);
});

test("an import whose data does not match is undone, volumes included", async () => {
  const s = seed();
  const db = initializeDatabase();
  const engine = new FakeEngine();
  engine.volumes.set("named:1-shop_pgdata", { "base/1": "row1", "PG_VERSION": "16" });
  const file = path.join(s.dir, "m.spbackup");
  await exportProject({ ...opts(s), projectId: s.projectId, outPath: file, engine });
  engine.dropOnImport = "base/1"; // a write that loses a file
  await assert.rejects(() => importProject({ ...opts(s), archivePath: file, name: "Bad copy", engine }), failsWith("digest-mismatch"));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 1, "the project row is gone");
  assert.ok(engine.removed.some((key) => key.includes("2-bad-copy_pgdata")), "the volume the import created is removed");
  assert.equal(engine.volumes.has("named:2-bad-copy_pgdata"), false);
});

test("a Docker volume that already exists is a refusal, and nothing is touched", async () => {
  const s = seed();
  const engine = new FakeEngine();
  engine.volumes.set("named:1-shop_pgdata", { "x": "1" });
  const file = path.join(s.dir, "e.spbackup");
  await exportProject({ ...opts(s), projectId: s.projectId, outPath: file, engine });
  engine.volumes.set("named:2-clash_pgdata", { "keep": "mine" });
  await assert.rejects(() => importProject({ ...opts(s), archivePath: file, name: "Clash", engine }), failsWith("invalid"));
  assert.deepEqual(engine.volumes.get("named:2-clash_pgdata"), { "keep": "mine" }, "a volume the import did not create is never removed");
  assert.equal(engine.removed.length, 0);
});

// The real helper: a root container reads data another user owns, and ownership survives. Needs Docker and an image with GNU tar and findutils
// (the Stackport image has both): STACKPORT_TEST_DOCKER_IMAGE=<image> npm test.
const IMAGE = process.env["STACKPORT_TEST_DOCKER_IMAGE"];
test("the real helper carries a database-style volume with its owner, and verifies it", { skip: !IMAGE }, async () => {
  const s = seed();
  const db = initializeDatabase();
  const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" });
  const engine = new DockerVolumeEngine(IMAGE as string);
  const suffix = crypto.randomBytes(3).toString("hex");
  const name = `Shop ${suffix}`;
  const slug = `shop-${suffix}`;
  const source = `1-${slug}_pgdata`;
  db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, s.projectId);
  const created: string[] = [];
  try {
    docker("volume", "create", "--label", `com.docker.compose.project=1-${slug}`, "--label", "com.docker.compose.volume=pgdata", source);
    created.push(source);
    docker("run", "--rm", "-v", `${source}:/v`, "--entrypoint", "sh", IMAGE as string, "-c", "mkdir -p /v/base /v/z/y && for i in $(seq 1 300); do echo $i > /v/base/f$i; done && echo late > /v/z/y/a && mkfifo /v/base/pipe && ln -s base /v/link && chown -R 999:999 /v && chmod 700 /v /v/base");
    // A volume with an explicit name is not named by Compose's rule: reported, not recreated under a name nothing would mount.
    docker("volume", "create", "--label", `com.docker.compose.project=1-${slug}`, "--label", "com.docker.compose.volume=custom", `elsewhere-${suffix}`);
    created.push(`elsewhere-${suffix}`);
    fs.writeFileSync(path.join(s.roots.containerDataRoot, "volumes", String(s.projectId), "m.txt"), "managed data");
    const file = path.join(s.dir, "real.spbackup");
    const manifest = await exportProject({ ...opts(s), projectId: s.projectId, outPath: file, engine });
    const named = (manifest.content.volumes ?? []).find((v) => v.kind === "named");
    assert.ok(named, "the named volume is in the archive");
    assert.ok((manifest.content.volumes ?? []).some((v) => v.kind === "managed"), "the managed directory is in the archive");
    assert.equal((manifest.content.volumes ?? []).some((v) => v.key === "custom"), false);
    assert.ok(manifest.notCarried.some((line) => line.includes(`elsewhere-${suffix}`)), "the custom-named volume is reported");

    const result = await importProject({ ...opts(s), archivePath: file, name: `Copy ${suffix}`, engine });
    const target = `${result.projectId}-copy-${suffix}_pgdata`;
    created.push(target);
    assert.equal(fs.readFileSync(path.join(s.roots.containerDataRoot, "volumes", String(result.projectId), "m.txt"), "utf8"), "managed data");
    assert.equal(await engine.treeDigest({ kind: "named", name: target }), named.tree, "the copy has the same tree: content, modes, owners and links");
    assert.match(docker("run", "--rm", "-v", `${target}:/v`, "--entrypoint", "sh", IMAGE as string, "-c", "ls -ln /v/base | tail -1; stat -c '%u %a' /v /v/base"), /999/);
    assert.match(docker("run", "--rm", "-v", `${target}:/v`, "--entrypoint", "sh", IMAGE as string, "-c", "ls /v/base | wc -l; test -p /v/base/pipe && echo fifo-ok; cat /v/z/y/a"), /301[\s\S]*fifo-ok[\s\S]*late/);
    assert.equal(docker("volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', target).trim(), `${result.projectId}-copy-${suffix}`, "Compose adopts it as its own");
  } finally {
    for (const volume of created) { try { docker("volume", "rm", "-f", volume); } catch { /* gone */ } }
  }
});
