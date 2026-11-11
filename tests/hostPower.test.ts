import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseHostStatus, powerRequestBody, powerRequester, PowerError, readPowerPreflight, readPowerState, requestCancel, requestReboot, signPowerRequest,
} from "../src/modules/maintenance/power";

const KEY = "test-power-key-0123456789abcdef";
const script = path.resolve(__dirname, "../stackport.sh");

/** A host in a temp directory: the real stackport.sh sourced against it, with `shutdown` replaced by a stub that records its arguments. */
function host(key: string | null = KEY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-power-"));
  const etc = path.join(root, "etc");
  const power = path.join(root, "var", "data", "power");
  fs.mkdirSync(etc, { recursive: true });
  fs.mkdirSync(power, { recursive: true });
  if (key) fs.writeFileSync(path.join(etc, "secrets.env"), `STACKPORT_POWER_KEY=${key}\n`);
  const calls = path.join(root, "shutdown-calls");
  const stub = path.join(root, "shutdown");
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >> '${calls.replace(/\\/g, "/")}'\n`, { mode: 0o755 });
  const toBash = (p: string): string => p.replace(/\\/g, "/");
  return {
    power,
    request(name: string, body: string): void { fs.writeFileSync(path.join(power, name), body); },
    run(): { out: string; status: ReturnType<typeof parseHostStatus> | null; shutdownCalls: string[]; left: string[] } {
      const result = spawnSync("bash", ["-c", `source '${toBash(script)}'; power_run`], {
        encoding: "utf8",
        env: { ...process.env, ETC_DIR: toBash(etc), VAR_DIR: toBash(path.join(root, "var")), POWER_DIR: toBash(power), SHUTDOWN_CMD: toBash(stub) },
      });
      let status: ReturnType<typeof parseHostStatus> | null = null;
      try { status = parseHostStatus(fs.readFileSync(path.join(power, "status"), "utf8")); } catch { /* none written */ }
      const shutdownCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
      return { out: `${result.stdout}${result.stderr}`, status, shutdownCalls, left: fs.readdirSync(power).filter((n) => n.endsWith("-request")) };
    },
  };
}

const now = (): number => Math.floor(Date.now() / 1000);

// ---- the host side, run for real in bash

test("a request signed by the app is accepted by the real script: the reboot is scheduled, and the request is consumed", () => {
  const h = host();
  h.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "vitor", 2));
  const r = h.run();
  assert.deepEqual(r.shutdownCalls, ["-r +2 Stackport: reboot requested by vitor"]);
  assert.equal(r.status?.state, "scheduled");
  assert.equal(r.status?.by, "vitor");
  assert.ok(r.status?.rebootAt && Math.abs(r.status.rebootAt - (now() + 120)) < 15);
  assert.deepEqual(r.left, [], "the request file is gone");
});

test("a delay of 0 means now", () => {
  const h = host();
  h.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "admin", 0));
  assert.deepEqual(h.run().shutdownCalls, ["-r now Stackport: reboot requested by admin"]);
});

test("nothing is scheduled for a request that is tampered with, signed with another key, stale, from the future, or not what it says it is", () => {
  const cases: [string, string, RegExp][] = [
    ["a changed delay", powerRequestBody(KEY, "reboot", now(), "admin", 1).replace("delay_min=1", "delay_min=0"), /signature does not match/],
    ["another key", powerRequestBody("some-other-key", "reboot", now(), "admin", 1), /signature does not match/],
    ["older than five minutes", powerRequestBody(KEY, "reboot", now() - 301, "admin", 1), /older than 300 seconds/],
    ["from the future", powerRequestBody(KEY, "reboot", now() + 3600, "admin", 1), /from the future/],
    ["a cancel in the reboot file", powerRequestBody(KEY, "cancel", now(), "admin", 0), /named for reboot but asks for cancel/],
    ["a second action line", `action=cancel\n${powerRequestBody(KEY, "reboot", now(), "admin", 1)}`, /no single action line/],
    ["a delay past an hour", powerRequestBody(KEY, "reboot", now(), "admin", 61), /delay_min is not 0 to 60/],
    ["a name with a space", powerRequestBody(KEY, "reboot", now(), "a b", 1), /by is not a plain name/],
    ["nothing useful", "hello\n", /no single action line/],
  ];
  for (const [label, body, reason] of cases) {
    const h = host();
    h.request("reboot-request", body);
    const r = h.run();
    assert.deepEqual(r.shutdownCalls, [], `${label}: no shutdown`);
    assert.equal(r.status?.state, "rejected", label);
    assert.match(r.status?.detail ?? "", reason, label);
    assert.deepEqual(r.left, [], `${label}: the file is consumed so it cannot loop the path unit`);
  }
});

test("a host with no power key refuses everything, and a request file that is too big or a link is not read", () => {
  const noKey = host(null);
  noKey.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "admin", 1));
  const r = noKey.run();
  assert.deepEqual(r.shutdownCalls, []);
  assert.match(r.status?.detail ?? "", /no power key/);

  const big = host();
  big.request("reboot-request", `${powerRequestBody(KEY, "reboot", now(), "admin", 1)}${"x".repeat(2000)}`);
  const b = big.run();
  assert.deepEqual(b.shutdownCalls, []);
  assert.equal(b.status?.state, "rejected");

  const linked = host();
  const target = path.join(linked.power, "elsewhere");
  fs.writeFileSync(target, powerRequestBody(KEY, "reboot", now(), "admin", 1));
  try { fs.symlinkSync(target, path.join(linked.power, "reboot-request")); } catch { return; /* a symbolic link cannot be made here (Windows without the right): the other cases hold */ }
  const l = linked.run();
  assert.deepEqual(l.shutdownCalls, [], "a link is not a request");
  assert.equal(l.status?.state, "rejected");
});

test("a signed cancel runs shutdown -c and is recorded", () => {
  const h = host();
  h.request("cancel-request", powerRequestBody(KEY, "cancel", now(), "vitor", 0));
  const r = h.run();
  assert.deepEqual(r.shutdownCalls, ["-c"]);
  assert.equal(r.status?.state, "cancelled");
  assert.deepEqual(r.left, []);
});

test("the shell and TypeScript sign the same string", () => {
  const out = spawnSync("bash", ["-c", `source '${script.replace(/\\/g, "/")}'; STACKPORT_POWER_KEY='${KEY}' power_mac reboot 1700000000 vitor 5`], { encoding: "utf8", env: { ...process.env, ETC_DIR: os.tmpdir().replace(/\\/g, "/"), VAR_DIR: os.tmpdir().replace(/\\/g, "/") } });
  assert.equal(out.stdout.trim(), signPowerRequest(KEY, "reboot", 1700000000, "vitor", 5));
});

// ---- the app side

function dirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-power-app-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("Power is available only with a key and the host's ready marker, and says what to do when it is not", () => {
  assert.match(readPowerState(Date.now(), dirWith({ ready: "" }), "").unavailableReason ?? "", /no power key/);
  assert.match(readPowerState(Date.now(), dirWith({}), KEY).unavailableReason ?? "", /host side is not set up/);
  const ok = readPowerState(Date.now(), dirWith({ ready: "" }), KEY);
  assert.deepEqual([ok.available, ok.requestPending, ok.rebootScheduled, ok.status], [true, false, false, null]);
});

test("a reboot request is written signed, validated, and refused while another is waiting or scheduled", () => {
  const dir = dirWith({ ready: "" });
  assert.throws(() => requestReboot("vitor", 61, Date.now(), dir, KEY), (e) => e instanceof PowerError && e.status === 400);
  assert.throws(() => requestReboot("vitor", "5", Date.now(), dir, KEY), (e) => e instanceof PowerError && e.status === 400);
  assert.throws(() => requestReboot("vitor", 1, Date.now(), dir, ""), (e) => e instanceof PowerError && e.status === 409);

  const at = 1_700_000_000_000;
  const state = requestReboot("Vitor M!", 5, at, dir, KEY);
  assert.equal(state.requestPending, true);
  const written = fs.readFileSync(path.join(dir, "reboot-request"), "utf8");
  assert.equal(written, powerRequestBody(KEY, "reboot", 1_700_000_000, "Vitor-M-", 5));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no half-written file is left");
  assert.throws(() => requestReboot("vitor", 1, at, dir, KEY), /already waiting/);

  fs.rmSync(path.join(dir, "reboot-request"));
  fs.writeFileSync(path.join(dir, "status"), `state=scheduled\nat=1700000000\nreboot_at=${1_700_000_300}\nby=vitor\n`);
  assert.equal(readPowerState(at, dir, KEY).rebootScheduled, true);
  assert.throws(() => requestReboot("vitor", 1, at, dir, KEY), /already scheduled/);
  assert.equal(readPowerState(1_700_000_400_000, dir, KEY).rebootScheduled, false, "a time that has passed is not scheduled any more");
});

test("a cancel needs something to cancel", () => {
  const dir = dirWith({ ready: "" });
  assert.throws(() => requestCancel("vitor", Date.now(), dir, KEY), /No reboot is scheduled/);
  fs.writeFileSync(path.join(dir, "status"), `state=scheduled\nreboot_at=${Math.floor(Date.now() / 1000) + 600}\n`);
  requestCancel("vitor", Date.now(), dir, KEY);
  assert.match(fs.readFileSync(path.join(dir, "cancel-request"), "utf8"), /^action=cancel\n/);
});

test("the host's status file is read defensively", () => {
  assert.deepEqual(parseHostStatus("state=scheduled\nat=1700000000\nreboot_at=1700000060\nby=vitor\n"), { state: "scheduled", at: 1700000000, rebootAt: 1700000060, by: "vitor", detail: null });
  assert.equal(parseHostStatus("state=weird\nat=abc\n").state, "unknown");
  assert.equal(parseHostStatus("state=rejected\ndetail=the signature does not match\n").detail, "the signature does not match");
  assert.equal(powerRequester(undefined), "admin");
  assert.equal(powerRequester("a".repeat(80)).length, 40);
});

test("the pre-flight lists containers that will not restart, and says when Docker could not be read", async () => {
  const run = async (args: string[]): Promise<string> => (args[0] === "ps" ? "a1\nb2\nc3\n" : "/web unless-stopped\n/job no\n/legacy \n");
  const p = await readPowerPreflight(run);
  assert.deepEqual([p.dockerRead, p.runningContainers, p.containersWithoutRestart], [true, 3, ["job", "legacy"]]);
  const broken = await readPowerPreflight(async () => { throw new Error("docker is down"); });
  assert.equal(broken.dockerRead, false);
});
