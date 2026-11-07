import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(__dirname, "../scripts/bump-version.cjs");

function project(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-bump-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "stackport", version }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "stackport", version, packages: { "": { version } } }));
  fs.mkdirSync(path.join(dir, "public"));
  return dir;
}

const read = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { version: string; packages?: Record<string, { version: string }> };

function run(dir: string, env: Record<string, string> = {}): void {
  execFileSync(process.execPath, [script, dir], { env: { ...process.env, STACKPORT_KEEP_VERSION: "", ...env }, stdio: "ignore" });
}

test("a local build still bumps the patch number, everywhere the version is written", () => {
  const dir = project("1.3.0");
  try {
    run(dir);
    assert.equal(read(dir, "package.json").version, "1.3.1");
    assert.equal(read(dir, "package-lock.json").version, "1.3.1");
    assert.equal(read(dir, "build-info.json").version, "1.3.1");
    assert.equal(read(dir, "public/version.json").version, "1.3.1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a release image build keeps the committed version, so the UI shows exactly it", () => {
  const dir = project("1.3.0");
  try {
    run(dir, { STACKPORT_KEEP_VERSION: "1" });
    assert.equal(read(dir, "package.json").version, "1.3.0");
    assert.equal(read(dir, "package-lock.json").version, "1.3.0");
    assert.equal(read(dir, "package-lock.json").packages?.[""]?.version, "1.3.0");
    assert.equal(read(dir, "build-info.json").version, "1.3.0");
    assert.equal(read(dir, "public/version.json").version, "1.3.0");
    run(dir, { STACKPORT_KEEP_VERSION: "1" });
    assert.equal(read(dir, "package.json").version, "1.3.0", "and it stays put on a rebuild");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the Dockerfile sets it for the build stage, ahead of both build scripts", () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8").replace(/\r\n/g, "\n");
  const env = dockerfile.indexOf("ENV STACKPORT_KEEP_VERSION=1");
  assert.ok(env > 0, "ENV is present");
  assert.ok(env < dockerfile.indexOf("RUN npm run build:api"), "before the server build");
  assert.ok(env < dockerfile.indexOf("RUN cd client && npm run build"), "before the client build");
});
