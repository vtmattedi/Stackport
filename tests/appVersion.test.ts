import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { checkForUpdates, getAppVersion } from "../src/services/appVersion";

const origin = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-origin-"));
process.on("exit", () => fs.rmSync(origin, { recursive: true, force: true }));
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
}

function commit(name: string): string {
  git("commit", "--quiet", "--allow-empty", "-m", name);
  return (sha[name] = git("rev-parse", "HEAD"));
}

// main: a - b - c - d - e, stable at c, the server runs b.
before(() => {
  git("init", "--quiet", "--initial-branch=main");
  for (const name of ["a", "b", "c", "d", "e"]) commit(name);
  git("branch", "stable", sha.c);
  process.env["STACKPORT_REPO_URL"] = origin;
  process.env["GIT_BRANCH"] = "stable";
  process.env["STACKPORT_COMMIT"] = sha.b;
});

test("lists what Update installs and what is still waiting on CI", async () => {
  const result = await checkForUpdates(null);
  assert.equal(result.ok, true, result.error ?? "");
  assert.equal(result.current?.message, "b");
  assert.deepEqual(result.available.map(c => c.message), ["c"]);
  assert.deepEqual(result.pending.map(c => c.message), ["e", "d"]);
});

test("a server ahead of stable has nothing to install and doesn't list what it runs as pending", async () => {
  process.env["STACKPORT_COMMIT"] = sha.d;
  try {
    const result = await checkForUpdates(null);
    assert.deepEqual(result.available, []);
    assert.deepEqual(result.pending.map(c => c.message), ["e"]);
  } finally {
    process.env["STACKPORT_COMMIT"] = sha.b;
  }
});

test("the running version is one commit, described from the cache", async () => {
  const version = await getAppVersion();
  assert.equal(version.commit?.sha, sha.b);
  assert.equal(version.commit?.message, "b");
});

test("concurrent checks share one fetch", async () => {
  const [a, b] = [checkForUpdates(null), checkForUpdates(null)];
  assert.equal(a, b);
  await a;
});

test("a missing repository is reported, not thrown", async () => {
  const saved = process.env["STACKPORT_REPO_URL"];
  delete process.env["STACKPORT_REPO_URL"];
  try {
    const result = await checkForUpdates(null);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not configured/);
  } finally {
    process.env["STACKPORT_REPO_URL"] = saved;
  }
});
