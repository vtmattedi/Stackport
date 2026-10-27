import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { initializeDatabase } from "../src/config/database";
import { checkoutPinnedCommit, COMMIT_SHA_RE } from "../src/services/projectDeploy";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

let origin: string;
let clone: string;
let first: string;
let second: string;

before(() => {
  initializeDatabase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-pin-"));
  origin = path.join(root, "origin");
  clone = path.join(root, "clone");
  fs.mkdirSync(origin);
  git(origin, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(origin, "f"), "1");
  git(origin, "add", "f");
  git(origin, "commit", "--quiet", "-m", "one");
  first = git(origin, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(origin, "f"), "2");
  git(origin, "commit", "--quiet", "-am", "two");
  second = git(origin, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", origin, clone);
});

test("checks out the pinned commit, not the branch tip", async () => {
  const results = await checkoutPinnedCommit(1, "deploy", clone, first, "main");
  assert.ok(results.every((r) => r.ok), results.map((r) => r.output).join("\n"));
  assert.equal(git(clone, "rev-parse", "HEAD"), first);
  assert.notEqual(first, second);
});

test("refuses a commit that is no longer on the branch", async () => {
  // Rewrite main so `second` leaves it, as a force-push would.
  git(origin, "reset", "--quiet", "--hard", first);
  fs.writeFileSync(path.join(origin, "f"), "3");
  git(origin, "commit", "--quiet", "-am", "three");
  git(clone, "fetch", "--quiet", "--prune");

  const results = await checkoutPinnedCommit(1, "deploy", clone, second, "main");
  assert.equal(results.some((r) => !r.ok), true);
  assert.match(results.map((r) => r.output).join("\n"), /not on origin\/main/);
  assert.notEqual(git(clone, "rev-parse", "HEAD"), second);
});

test("only hex SHAs are accepted, so a SHA can never be read as a git option", () => {
  assert.equal(COMMIT_SHA_RE.test("a1b2c3d"), true);
  assert.equal(COMMIT_SHA_RE.test("--upload-pack=x"), false);
  assert.equal(COMMIT_SHA_RE.test("main"), false);
});
