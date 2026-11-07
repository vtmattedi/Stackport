import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAppVersion } from "../src/modules/maintenance/version";

const root = path.resolve(__dirname, "..");
const read = (file: string): { version: string; packages?: Record<string, { version?: string }> } =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

/** Server and client ship in one image under one version. Every file that records it must
 *  agree, or the UI reports a version that is not the one that was released. */
const FILES = [
  "package.json",
  "package-lock.json",
  "build-info.json",
  "client/package.json",
  "client/package-lock.json",
  "client/build-info.json",
  "client/public/version.json",
];

test("every file that records the version records the same one", () => {
  const versions = Object.fromEntries(FILES.map((file) => [file, read(file).version]));
  assert.deepEqual(new Set(Object.values(versions)).size, 1, `versions differ: ${JSON.stringify(versions, null, 2)}`);
  for (const lock of ["package-lock.json", "client/package-lock.json"]) {
    assert.equal(read(lock).packages?.[""]?.version, read(lock).version, `${lock}: root package entry`);
  }
});

test("the version is a plain release number", () => {
  assert.match(read("package.json").version, /^\d+\.\d+\.\d+$/);
});

test("the MCP servers announce the app version, not a hard-coded one", () => {
  for (const file of ["src/transports/mcp/http.ts", "src/transports/mcp/stdio.ts"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /version:\s*"\d/, `${file} hard-codes a version`);
    assert.match(source, /version:\s*packageVersion\(\)/, `${file} should announce packageVersion()`);
  }
});

test("the version the app reports is the one in package.json", async () => {
  assert.equal((await getAppVersion()).version, read("package.json").version);
});
