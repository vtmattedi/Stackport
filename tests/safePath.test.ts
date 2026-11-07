import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveContainedPath } from "../src/shared/safePath";

let base: string;
let root: string;
let outside: string;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sp-safepath-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "inside"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");
  // A junction works for directories on Windows without elevated rights.
  fs.symlinkSync(outside, path.join(root, "escape"), "junction");
  fs.symlinkSync(path.join(root, "inside"), path.join(root, "alias"), "junction");
});
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

test("ordinary paths, existing or not, resolve inside the root", () => {
  assert.equal(resolveContainedPath(root, "inside"), path.join(root, "inside"));
  assert.equal(resolveContainedPath(root, "inside/new/deeper.txt"), path.join(root, "inside", "new", "deeper.txt"));
  assert.equal(resolveContainedPath(root, "."), root);
});

test(".. segments that leave the root are refused", () => {
  assert.equal(resolveContainedPath(root, "../outside/secret.txt"), null);
  assert.equal(resolveContainedPath(root, "inside/../../outside"), null);
});

test("a symlink inside the root that points outside it is refused", () => {
  assert.equal(resolveContainedPath(root, "escape"), null);
  assert.equal(resolveContainedPath(root, "escape/secret.txt"), null);
  assert.equal(resolveContainedPath(root, "escape/not-created-yet.txt"), null, "a new file would be created outside");
});

test("a symlink that stays inside the root is fine", () => {
  assert.equal(resolveContainedPath(root, "alias/file.txt"), path.join(root, "alias", "file.txt"));
});

test("a root that is itself reached through a symlink still works", () => {
  const viaLink = path.join(base, "root-link");
  fs.symlinkSync(root, viaLink, "junction");
  assert.equal(resolveContainedPath(viaLink, "inside"), path.join(viaLink, "inside"));
  assert.equal(resolveContainedPath(viaLink, "escape"), null);
});

test("a dangling file symlink is refused when it can be created", (t) => {
  const link = path.join(root, "dangling");
  try { fs.symlinkSync(path.join(outside, "missing.txt"), link, "file"); }
  catch { t.skip("creating file symlinks needs privileges on this machine"); return; }
  assert.equal(resolveContainedPath(root, "dangling"), null);
});
