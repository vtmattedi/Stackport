import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { issueAuthToken, isSessionLive, verifyStoredAuthToken } from "../src/modules/identity/sessions";
import { socketSessionIsLive, sweepEndedSessions, type GuardedSocket } from "../src/transports/socket/sessionGuard";
import { composeSubcommandNeedsPolicy, restartBlocker } from "../src/modules/deployments/operations";
import { recordSuccessfulDeployment } from "../src/modules/deployments/history";
import { projectRepoDir } from "../src/modules/projects/workspace";
import { seedManagedDirectory } from "../src/modules/deployments/compose/seedVolumes";

before(() => { initializeDatabase(); });

const HOUR = 3_600_000;

// ---- 1. build is checked like up

test("the compose policy runs before up, config and build, and not before commands that read no files", () => {
  for (const sub of ["up", "config", "build"]) assert.equal(composeSubcommandNeedsPolicy(sub), true, sub);
  for (const sub of ["down", "ps", "rm", "stop", "pull", undefined]) assert.equal(composeSubcommandNeedsPolicy(sub), false, String(sub));
});

// ---- 2. a socket does not outlive its session

function fakeSocket(tokenId: unknown): GuardedSocket & { events: string[]; closed: boolean } {
  const socket = {
    data: { authTokenId: tokenId } as Record<string, unknown>,
    events: [] as string[],
    closed: false,
    emit(event: string) { socket.events.push(event); },
    disconnect() { socket.closed = true; },
  };
  return socket;
}

test("a session is live until it expires, reaches its cap or is deleted, and checking does not extend it", () => {
  const verified = verifyStoredAuthToken(issueAuthToken("admin"))!;
  assert.equal(isSessionLive(verified.tokenId), true);
  const before = getDatabase().prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(verified.tokenId);
  isSessionLive(verified.tokenId);
  assert.deepEqual(getDatabase().prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(verified.tokenId), before);

  getDatabase().prepare("UPDATE auth_tokens SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 13 * HOUR).toISOString(), verified.tokenId);
  assert.equal(isSessionLive(verified.tokenId), false, "past the 12 hour cap");

  const expired = verifyStoredAuthToken(issueAuthToken("admin"))!;
  getDatabase().prepare("UPDATE auth_tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.tokenId);
  assert.equal(isSessionLive(expired.tokenId), false);

  const gone = verifyStoredAuthToken(issueAuthToken("admin"))!;
  getDatabase().prepare("DELETE FROM auth_tokens WHERE id = ?").run(gone.tokenId);
  assert.equal(isSessionLive(gone.tokenId), false, "logged out or revoked");
  assert.equal(isSessionLive("never-existed"), false);
});

test("a socket whose session has ended is told and closed; one with a live session is left alone", () => {
  const live = verifyStoredAuthToken(issueAuthToken("admin"))!;
  const ok = fakeSocket(live.tokenId);
  assert.equal(socketSessionIsLive(ok), true);
  assert.deepEqual([ok.events, ok.closed], [[], false]);

  getDatabase().prepare("DELETE FROM auth_tokens WHERE id = ?").run(live.tokenId);
  assert.equal(socketSessionIsLive(ok), false);
  assert.deepEqual(ok.events, ["auth:revoked"]);
  assert.equal(ok.closed, true);
});

test("a socket that never had a session id is closed, and the sweep closes only the ended ones", () => {
  assert.equal(socketSessionIsLive(fakeSocket(undefined)), false);
  const live = fakeSocket("live");
  const dead = fakeSocket("dead");
  const closed = sweepEndedSessions([live, dead], (id) => id === "live");
  assert.equal(closed, 1);
  assert.deepEqual([live.closed, dead.closed], [false, true]);
});

// ---- 4. a restart only restarts what is running

function gitRepoFor(projectId: number, name: string): { dir: string; head: () => string; commit: (file: string) => string } {
  const dir = projectRepoDir({ id: projectId, name });
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (file: string): string => { fs.writeFileSync(path.join(dir, file), file); git("add", "."); git("commit", "-q", "-m", file); return git("rev-parse", "HEAD"); };
  return { dir, head: () => git("rev-parse", "HEAD"), commit };
}
const deployed = (projectId: number, sha: string) => recordSuccessfulDeployment(projectId, { commitSha: sha, branch: "main", composeFileName: "compose.yml", sourceCompose: "x", effectiveCompose: "x", triggeredBy: "manual" });

test("restart: allowed while the checkout is at the deployed commit, refused once it has moved on", async () => {
  const project = createProject({ name: "restart-fixture", sourceType: "github", githubRepo: "owner/repo" });
  const repo = gitRepoFor(project.id, project.name);
  const first = repo.commit("a.txt");
  deployed(project.id, first);
  assert.equal(await restartBlocker(project.id), null);

  const second = repo.commit("b.txt"); // pulled, not deployed
  const blocker = await restartBlocker(project.id);
  assert.match(String(blocker), new RegExp(`checkout is at ${second.slice(0, 7)} but the running revision is ${first.slice(0, 7)}`));
  assert.match(String(blocker), /Deploy the new revision, or roll back/);

  deployed(project.id, second);
  assert.equal(await restartBlocker(project.id), null, "deploying it makes it the running revision");
});

test("restart: with no recorded deployment, or an upload project, there is nothing to compare", async () => {
  const github = createProject({ name: "restart-nodeploy", sourceType: "github", githubRepo: "owner/repo2" });
  assert.equal(await restartBlocker(github.id), null);
  const upload = createProject({ name: "restart-upload", sourceType: "upload" });
  deployed(upload.id, "0".repeat(40));
  assert.equal(await restartBlocker(upload.id), null);
  assert.match(String(await restartBlocker(999999)), /not found/i);
});

// ---- 5. a new managed directory starts with the repository's own files

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "seed-")); }

test("seed: a new managed directory is filled from the repository's folder, including nested files", async () => {
  const root = tmp();
  try {
    const source = path.join(root, "repo", "data");
    fs.mkdirSync(path.join(source, "sub"), { recursive: true });
    fs.writeFileSync(path.join(source, "init.sql"), "create table t;");
    fs.writeFileSync(path.join(source, "sub", "seed.json"), "{}");
    const target = path.join(root, "volumes", "7", "data-abc");
    assert.equal(await seedManagedDirectory(source, target), "seeded");
    assert.equal(fs.readFileSync(path.join(target, "init.sql"), "utf8"), "create table t;");
    assert.equal(fs.readFileSync(path.join(target, "sub", "seed.json"), "utf8"), "{}");
    assert.equal(fs.existsSync(`${target}.seeding`), false, "no staging directory is left behind");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("seed: it happens once; later deploys never overwrite what the application wrote", async () => {
  const root = tmp();
  try {
    const source = path.join(root, "src"); const target = path.join(root, "managed");
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, "config.ini"), "default");
    await seedManagedDirectory(source, target);
    fs.writeFileSync(path.join(target, "config.ini"), "changed by the app");
    fs.writeFileSync(path.join(source, "config.ini"), "new default in a later commit");
    fs.writeFileSync(path.join(source, "added.txt"), "added later");
    assert.equal(await seedManagedDirectory(source, target), "exists");
    assert.equal(fs.readFileSync(path.join(target, "config.ini"), "utf8"), "changed by the app");
    assert.equal(fs.existsSync(path.join(target, "added.txt")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("seed: an existing directory, even an empty one, is never seeded (an intentionally empty volume stays empty)", async () => {
  const root = tmp();
  try {
    const source = path.join(root, "src"); const target = path.join(root, "managed");
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, "f"), "x");
    fs.mkdirSync(target);
    assert.equal(await seedManagedDirectory(source, target), "exists");
    assert.deepEqual(fs.readdirSync(target), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("seed: a missing or empty repository folder just gives an empty directory", async () => {
  const root = tmp();
  try {
    assert.equal(await seedManagedDirectory(path.join(root, "nope"), path.join(root, "a")), "no-source");
    fs.mkdirSync(path.join(root, "empty"));
    assert.equal(await seedManagedDirectory(path.join(root, "empty"), path.join(root, "b")), "empty-source");
    assert.deepEqual([fs.readdirSync(path.join(root, "a")), fs.readdirSync(path.join(root, "b"))], [[], []]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("seed: a link in the repository is copied as a link, not followed", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, async () => {
  const root = tmp();
  try {
    const source = path.join(root, "src"); const target = path.join(root, "managed");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(root, "outside-secret"), "secret");
    fs.symlinkSync("../outside-secret", path.join(source, "link"));
    assert.equal(await seedManagedDirectory(source, target), "seeded");
    assert.equal(fs.lstatSync(path.join(target, "link")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(target, "link")), "../outside-secret");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
