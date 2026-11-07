import { test } from "node:test";
import assert from "node:assert/strict";
import { isInsideDir, rebasePath, relativeInside } from "../src/shared/hostPath";

test("a path inside a POSIX directory is found, a sibling that shares its prefix is not", () => {
  assert.equal(relativeInside("/app/data/repos/7-x/data", "/app/data/repos/7-x"), "data");
  assert.equal(relativeInside("/app/data/repos/7-x", "/app/data/repos/7-x"), "");
  assert.equal(relativeInside("/app/data/repos/7-x-other", "/app/data/repos/7-x"), null);
  assert.equal(relativeInside("/etc", "/app/data"), null);
  assert.equal(relativeInside("relative/path", "/app/data"), null);
});

test("Windows paths are compared without regard to case", () => {
  assert.equal(isInsideDir("c:\\deploy\\7-app\\data", "C:\\Deploy\\7-app"), true);
  assert.equal(isInsideDir("C:\\Windows", "C:\\Deploy\\7-app"), false);
});

test("rebasePath moves a path from the container's data root to the host's", () => {
  assert.equal(rebasePath("/app/data/repos/7-x/db", "/app/data", "/var/lib/stackport/data"), "/var/lib/stackport/data/repos/7-x/db");
  assert.equal(rebasePath("/app/data", "/app/data", "/var/lib/stackport/data"), "/var/lib/stackport/data");
  assert.equal(rebasePath("/srv/elsewhere", "/app/data", "/var/lib/stackport/data"), "/srv/elsewhere");
});

test("a child whose name starts with two dots is inside, not outside", () => {
  assert.equal(relativeInside("/app/data/repos/7-x/..data", "/app/data/repos/7-x"), "..data");
  assert.equal(relativeInside("/app/data/repos/7-x/..data/x", "/app/data/repos/7-x"), "..data/x");
  assert.equal(relativeInside("/app/data/repos/7-x/../8-y", "/app/data/repos/7-x"), null, "a real parent step still leaves it");
  assert.equal(isInsideDir("C:\\Deploy\\7-app\\..data", "C:\\Deploy\\7-app"), true);
});

test("rebasing a Windows path keeps the case of the path it was given", () => {
  assert.equal(relativeInside("C:\\Deploy\\7-app\\Data\\Foo", "c:\\deploy\\7-APP"), "Data\\Foo");
  assert.equal(rebasePath("C:\\Data\\Repos\\Foo", "c:\\data", "D:\\Host"), "D:\\Host\\Repos\\Foo");
});
