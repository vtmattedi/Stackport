import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { closeDatabase, initializeDatabase } from "../src/config/database";
import { getReadiness } from "../src/services/readiness";
import { updaterRunArgs } from "../src/services/selfUpdate";

const IMAGE = "sha256:" + "f".repeat(64);

test("ready when the database answers and nothing else is required", async () => {
  initializeDatabase();
  const readiness = await getReadiness({ requireBundle: false, requireDocker: false });
  assert.equal(readiness.ok, true);
  assert.deepEqual(Object.keys(readiness.checks), ["database"]);
  closeDatabase();
});

test("a closed database fails readiness", async () => {
  const readiness = await getReadiness({ requireBundle: false, requireDocker: false });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.checks["database"]?.ok, false);
});

test("the UI bundle is checked when it's required", async () => {
  initializeDatabase();
  const index = path.join(os.tmpdir(), `stackport-index-${process.pid}.html`);
  const missing = await getReadiness({ requireBundle: true, requireDocker: false, bundleIndex: index });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks["bundle"]?.ok, false);
  fs.writeFileSync(index, "<!doctype html>");
  const present = await getReadiness({ requireBundle: true, requireDocker: false, bundleIndex: index });
  fs.rmSync(index);
  assert.equal(present.ok, true);
  closeDatabase();
});

test("the updater runs the host CLI from the current image, detached for real updates", () => {
  const args = updaterRunArgs(IMAGE, "stackport-updater", ["/usr/local/bin/stackport", "update"], { detach: true });
  assert.deepEqual(args.slice(0, 4), ["run", "--detach", "--name", "stackport-updater"]);
  assert.ok(args.includes("type=bind,src=/,dst=/host"), "the host root must be mounted for chroot");
  assert.deepEqual(args.slice(args.indexOf("--entrypoint"), args.indexOf("--entrypoint") + 4), ["--entrypoint", "chroot", IMAGE, "/host"]);
  assert.deepEqual(args.slice(-2), ["/usr/local/bin/stackport", "update"]);
});

test("the self-test uses the same launch, removed after it exits", () => {
  const update = updaterRunArgs(IMAGE, "x", ["true"], { detach: true });
  const selftest = updaterRunArgs(IMAGE, "x", ["true"], { detach: false });
  assert.equal(selftest[1], "--rm");
  assert.deepEqual(selftest.slice(2), update.slice(2), "only detach vs --rm may differ");
});
