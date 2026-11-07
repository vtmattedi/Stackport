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
