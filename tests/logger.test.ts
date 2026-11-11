import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildLogger } from "../src/shared/logger";

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, done) { chunks.push(String(chunk)); done(); } });
  return { stream, lines: () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test("in production warnings and errors reach the console, info stays in the file only (P4)", () => {
  const out = capture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-logger-"));
  const log = buildLogger({ nodeEnv: "production", logLevel: "info", logDir: dir, consoleStream: out.stream });
  log.info("routine");
  log.warn("network pool nearly full");
  log.error("nginx config failed");
  const seen = out.lines().map((l) => l["msg"]);
  assert.deepEqual(seen, ["network pool nearly full", "nginx config failed"]);
});

test("a higher configured level also raises what the console shows", () => {
  const out = capture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-logger-"));
  const log = buildLogger({ nodeEnv: "production", logLevel: "error", logDir: dir, consoleStream: out.stream });
  log.warn("hidden");
  log.error("shown");
  assert.deepEqual(out.lines().map((l) => l["msg"]), ["shown"]);
});
