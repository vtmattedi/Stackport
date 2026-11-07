import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const script = fs.readFileSync(path.resolve(__dirname, "../scripts/e2e/upgrade.sh"), "utf8").replace(/\r\n/g, "\n");

function fixture(run: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-upgrade-layout-"));
  try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function write(directory: string, filename: string, contents: string): void {
  const target = path.join(directory, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

test("upgrade readiness checks cover historical and module layouts without requiring pre-readiness releases", { skip: process.platform === "win32" }, () => {
  // Execute the actual driver's gate against committed trees, not a duplicate predicate.
  const condition = script.match(/if (git -C "\$APP_DIR" cat-file[\s\S]*?); then/)?.[1];
  assert.ok(condition);
  for (const readiness of [null, "src/services/readiness.ts", "src/modules/maintenance/readiness.ts"]) {
    fixture(directory => {
      write(directory, "marker", "fixture");
      if (readiness) write(directory, readiness, "export {};");
      const git = (...args: string[]): void => { execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" }); };
      git("init", "--quiet");
      git("add", ".");
      git("-c", "user.name=Layout test", "-c", "user.email=layout@example.test", "commit", "--quiet", "-m", "fixture");
      const result = execFileSync("bash", ["-c", `set -euo pipefail\nif ${condition}; then echo required; else echo unavailable; fi`], {
        env: { ...process.env, APP_DIR: directory }, encoding: "utf8",
      });
      assert.equal(result.trim(), readiness ? "required" : "unavailable");
    });
  }
});

test("upgrade app launcher supports old images and prefers the canonical module when present", () => {
  const launcher = script.match(/"(const fs = require\('fs'\);[^\n]+)"/)?.[1];
  assert.ok(launcher);
  for (const layout of ["old", "new", "both"]) {
    fixture(directory => {
      if (layout !== "new") write(directory, "dist/services/selfUpdate.js", "exports.startSelfUpdate = async () => ({ id: 'historical' });");
      if (layout !== "old") write(directory, "dist/modules/maintenance/selfUpdate.js", "exports.startSelfUpdate = async () => ({ id: 'canonical' });");
      const result = execFileSync(process.execPath, ["-e", launcher], { cwd: directory, encoding: "utf8" });
      assert.equal(result.trim(), `updater ${layout === "old" ? "historical" : "canonical"}`);
    });
  }
});
