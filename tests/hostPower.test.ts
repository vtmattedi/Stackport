import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseHostError, parseHostSchedule, powerRequestBody, powerRequester, PowerError, readPowerPreflight, readPowerState, REQUEST_MAX_AGE_S, requestCancel, requestReboot,
  signPowerRequest, type PowerDirs,
} from "../src/modules/maintenance/power";

const KEY = "test-power-key-0123456789abcdef";
const script = path.resolve(__dirname, "../stackport.sh").replace(/\\/g, "/");
const toBash = (p: string): string => p.replace(/\\/g, "/");
const now = (): number => Math.floor(Date.now() / 1000);

/** A host in a temp directory: the real stackport.sh sourced against it, with `shutdown` replaced by a stub that records its arguments. */
function host(key: string | null = KEY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-power-"));
  const etc = path.join(root, "etc");
  const requests = path.join(root, "var", "data", "power");
  const state = path.join(root, "var", "power");
  fs.mkdirSync(etc, { recursive: true });
  fs.mkdirSync(requests, { recursive: true });
  if (key) fs.writeFileSync(path.join(etc, "secrets.env"), `STACKPORT_POWER_KEY=${key}\n`);
  const calls = path.join(root, "shutdown-calls");
  const stub = path.join(root, "shutdown");
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >> '${toBash(calls)}'\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    ETC_DIR: toBash(etc), VAR_DIR: toBash(path.join(root, "var")), POWER_DIR: toBash(requests), POWER_STATE_DIR: toBash(state), SHUTDOWN_CMD: toBash(stub),
    // The real script reads a request as the app's user with setpriv, which needs root; here `env` stands in for it.
    POWER_READ_AS: "env",
  };
  const shutdownCalls = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
  const read = (name: string): string | null => { try { return fs.readFileSync(path.join(state, name), "utf8"); } catch { return null; } };
  return {
    requests, state,
    request(name: string, body: string): void { fs.writeFileSync(path.join(requests, name), body); },
    bash(code: string) {
      const result = spawnSync("bash", ["-c", `source '${script}'; ${code}`], { encoding: "utf8", env });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    },
    run() {
      const result = this.bash("power_run");
      const schedule = read("status");
      const error = read("last-error");
      return {
        out: result.out, shutdownCalls: shutdownCalls(),
        schedule: schedule === null ? null : parseHostSchedule(schedule),
        error: error === null ? null : parseHostError(error),
        leftRequests: fs.readdirSync(requests).filter((n) => n.endsWith("-request")),
        requestDirEntries: fs.readdirSync(requests),
      };
    },
  };
}

// ---- the host side, run for real in bash

test("a request signed by the app is accepted by the real script: the reboot is scheduled, and the request is consumed", () => {
  const h = host();
  h.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "vitor", 2));
  const r = h.run();
  assert.deepEqual(r.shutdownCalls, ["-r +2 Stackport: reboot requested by vitor"]);
  assert.equal(r.schedule?.state, "scheduled");
  assert.equal(r.schedule?.by, "vitor");
  assert.ok(r.schedule?.rebootAt && Math.abs(r.schedule.rebootAt - (now() + 120)) < 15);
  assert.equal(r.error, null);
  assert.deepEqual(r.requestDirEntries, [], "the request is gone, and the host wrote nothing into the app's directory");
});

test("a delay of 0 means now, and a delay with a leading zero is decimal, not octal", () => {
  const h = host();
  h.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "admin", 0));
  assert.deepEqual(h.run().shutdownCalls, ["-r now Stackport: reboot requested by admin"]);
  const cli = host();
  assert.match(cli.bash("reboot_host --in 08 --yes").out, /reboot scheduled \(\+8\)/);
  assert.match(cli.bash("reboot_host --in 010 --yes").out, /reboot scheduled \(\+10\)/);
  assert.match(cli.bash("reboot_host --in 99 --yes").out, /--in takes a number of minutes from 0 to 60/);
});

test("nothing is scheduled for a request that is tampered with, signed with another key, stale, from the future, or not what it says it is", () => {
  const cases: [string, string, RegExp][] = [
    ["a changed delay", powerRequestBody(KEY, "reboot", now(), "admin", 1).replace("delay_min=1", "delay_min=0"), /signature does not match/],
    ["another key", powerRequestBody("some-other-key", "reboot", now(), "admin", 1), /signature does not match/],
    ["older than five minutes", powerRequestBody(KEY, "reboot", now() - 301, "admin", 1), /older than 300 seconds/],
    ["from the future", powerRequestBody(KEY, "reboot", now() + 3600, "admin", 1), /from the future/],
    ["a cancel in the reboot file", powerRequestBody(KEY, "cancel", now(), "admin", 0), /named for reboot but asks for something else/],
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
    assert.equal(r.error?.state, "rejected", label);
    assert.match(r.error?.detail ?? "", reason, label);
    assert.deepEqual(r.leftRequests, [], `${label}: the file is consumed so it cannot loop the path unit`);
  }
});

test("a refused request does not hide a reboot that is still scheduled, so it can still be cancelled", () => {
  const h = host();
  h.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "vitor", 15));
  const first = h.run();
  assert.equal(first.schedule?.state, "scheduled");
  h.request("cancel-request", powerRequestBody("wrong-key", "cancel", now(), "vitor", 0));
  const second = h.run();
  assert.equal(second.schedule?.state, "scheduled", "the schedule stands");
  assert.equal(second.schedule?.rebootAt, first.schedule?.rebootAt);
  assert.equal(second.error?.state, "rejected");
  // The app sees both, and a good cancel then clears the error.
  h.request("cancel-request", powerRequestBody(KEY, "cancel", now(), "vitor", 0));
  const third = h.run();
  assert.equal(third.schedule?.state, "cancelled");
  assert.equal(third.error, null);
  assert.deepEqual(third.shutdownCalls, ["-r +15 Stackport: reboot requested by vitor", "-c"]);
});

test("a host with no power key refuses everything; a request that is too big, or a link, is refused too", () => {
  const noKey = host(null);
  noKey.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "admin", 1));
  const r = noKey.run();
  assert.deepEqual(r.shutdownCalls, []);
  assert.match(r.error?.detail ?? "", /no power key/);

  const big = host();
  big.request("reboot-request", `${powerRequestBody(KEY, "reboot", now(), "admin", 1)}${"x".repeat(2000)}`);
  const b = big.run();
  assert.deepEqual(b.shutdownCalls, []);
  assert.equal(b.error?.state, "rejected");

  const linked = host();
  const target = path.join(linked.requests, "elsewhere");
  fs.writeFileSync(target, powerRequestBody(KEY, "reboot", now(), "admin", 1));
  try { fs.symlinkSync(target, path.join(linked.requests, "reboot-request")); } catch { return; /* a link cannot be made here (Windows without the right): the other cases hold */ }
  const l = linked.run();
  assert.deepEqual(l.shutdownCalls, [], "a link is not a request");
  assert.equal(l.error?.state, "rejected");
});

test("the request is read through the reader command (as the app's user in production), never by the script itself", () => {
  // If the script opened the file itself this wrapper would not run. It records that it was asked to read, and reads nothing.
  const h = host();
  h.request("reboot-request", powerRequestBody(KEY, "reboot", now(), "admin", 1));
  const marker = path.join(h.requests, "..", "reader-ran");
  const reader = path.join(h.requests, "..", "reader.sh");
  fs.writeFileSync(reader, `#!/usr/bin/env bash
echo "$@" >> '${toBash(marker)}'
exit 1
`, { mode: 0o755 });
  const result = spawnSync("bash", ["-c", `source '${script}'; power_run`], {
    encoding: "utf8",
    env: { ...process.env, ETC_DIR: toBash(os.tmpdir()), VAR_DIR: toBash(os.tmpdir()), POWER_DIR: toBash(h.requests), POWER_STATE_DIR: toBash(h.state), SHUTDOWN_CMD: "true", POWER_READ_AS: toBash(reader) },
  });
  assert.ok(fs.existsSync(marker), `the reader ran: ${result.stderr}`);
  assert.match(fs.readFileSync(marker, "utf8"), /^head -c 2048 -- .*reboot-request/, "it was asked to read the request, bounded to 2 KiB");
  assert.deepEqual(fs.readdirSync(h.requests).filter((n) => n.endsWith("-request")), [], "and the request was still consumed");
});

test("the pre-flight is information: it succeeds when Docker is down, so a wedged host can still be rebooted", () => {
  const h = host();
  const r = h.bash("docker() { return 1; }; power_preflight; echo reached-the-end");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /reached-the-end/);
});

test("a signed cancel runs shutdown -c and is recorded", () => {
  const h = host();
  h.request("cancel-request", powerRequestBody(KEY, "cancel", now(), "vitor", 0));
  const r = h.run();
  assert.deepEqual(r.shutdownCalls, ["-c"]);
  assert.equal(r.schedule?.state, "cancelled");
  assert.deepEqual(r.leftRequests, []);
});

test("the shell and TypeScript sign the same string", () => {
  const out = spawnSync("bash", ["-c", `source '${script}'; STACKPORT_POWER_KEY='${KEY}' power_mac reboot 1700000000 vitor 5`], { encoding: "utf8", env: { ...process.env, ETC_DIR: toBash(os.tmpdir()), VAR_DIR: toBash(os.tmpdir()) } });
  assert.equal(out.stdout.trim(), signPowerRequest(KEY, "reboot", 1700000000, "vitor", 5));
});

// ---- the app side

function dirsWith(files: { requests?: Record<string, string>; state?: Record<string, string> }, key = KEY): PowerDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-power-app-"));
  const requests = path.join(root, "requests");
  const state = path.join(root, "state");
  fs.mkdirSync(requests);
  fs.mkdirSync(state);
  for (const [name, text] of Object.entries(files.requests ?? {})) fs.writeFileSync(path.join(requests, name), text);
  for (const [name, text] of Object.entries(files.state ?? {})) fs.writeFileSync(path.join(state, name), text);
  return { requests, state, key };
}

test("Power is available only with a key and the host's ready marker, and says what to do when it is not", () => {
  assert.match(readPowerState(Date.now(), dirsWith({ state: { ready: "" } }, "")).unavailableReason ?? "", /no power key/);
  assert.match(readPowerState(Date.now(), dirsWith({})).unavailableReason ?? "", /host side is not set up/);
  const ok = readPowerState(Date.now(), dirsWith({ state: { ready: "" } }));
  assert.deepEqual([ok.available, ok.requestPending, ok.requestStale, ok.rebootScheduled, ok.schedule, ok.lastError], [true, false, false, false, null, null]);
});

test("a reboot request is written signed, validated, and refused while another is waiting or scheduled", () => {
  const dirs = dirsWith({ state: { ready: "" } });
  assert.throws(() => requestReboot("vitor", 61, Date.now(), dirs), (e) => e instanceof PowerError && e.status === 400);
  assert.throws(() => requestReboot("vitor", "5", Date.now(), dirs), (e) => e instanceof PowerError && e.status === 400);
  assert.throws(() => requestReboot("vitor", 1, Date.now(), { ...dirs, key: "" }), (e) => e instanceof PowerError && e.status === 409);

  const at = Date.now();
  const state = requestReboot("Vitor M!", 5, at, dirs);
  assert.equal(state.requestPending, true);
  const written = fs.readFileSync(path.join(dirs.requests, "reboot-request"), "utf8");
  assert.equal(written, powerRequestBody(KEY, "reboot", Math.floor(at / 1000), "Vitor-M-", 5));
  assert.deepEqual(fs.readdirSync(dirs.requests).filter((n) => n.endsWith(".tmp")), [], "no half-written file is left");
  assert.throws(() => requestReboot("vitor", 1, at, dirs), /already waiting/);

  fs.rmSync(path.join(dirs.requests, "reboot-request"));
  fs.writeFileSync(path.join(dirs.state, "status"), `state=scheduled\nat=${Math.floor(at / 1000)}\nreboot_at=${Math.floor(at / 1000) + 300}\nby=vitor\n`);
  assert.equal(readPowerState(at, dirs).rebootScheduled, true);
  assert.throws(() => requestReboot("vitor", 1, at, dirs), /already scheduled/);
  assert.equal(readPowerState(at + 400_000, dirs).rebootScheduled, false, "a time that has passed is not scheduled any more");
});

test("a request nobody picks up goes stale, is reported as such, and is replaced by the next one instead of blocking it", () => {
  const dirs = dirsWith({ state: { ready: "" } });
  const at = Date.now();
  requestReboot("vitor", 1, at, dirs);
  const later = at + (REQUEST_MAX_AGE_S + 60) * 1000;
  const aged = new Date(at);
  fs.utimesSync(path.join(dirs.requests, "reboot-request"), aged, aged);
  const stale = readPowerState(later, dirs);
  assert.deepEqual([stale.requestPending, stale.requestStale], [false, true]);
  requestReboot("vitor", 2, later, dirs);
  // The test's clock is ahead of the real one that stamped the new file, so move the file to the test's time before reading it back.
  fs.utimesSync(path.join(dirs.requests, "reboot-request"), new Date(later), new Date(later));
  assert.equal(readPowerState(later, dirs).requestPending, true);
  assert.equal(fs.readFileSync(path.join(dirs.requests, "reboot-request"), "utf8"), powerRequestBody(KEY, "reboot", Math.floor(later / 1000), "vitor", 2), "the stale file was replaced");
});

test("a cancel needs a scheduled reboot; a refusal is shown only while it is newer than the schedule", () => {
  const dirs = dirsWith({ state: { ready: "" } });
  assert.throws(() => requestCancel("vitor", Date.now(), dirs), /No reboot is scheduled/);
  const at = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dirs.state, "status"), `state=scheduled\nat=${at}\nreboot_at=${at + 600}\n`);
  fs.writeFileSync(path.join(dirs.state, "last-error"), `state=rejected\nat=${at + 5}\ndetail=the signature does not match\n`);
  const shown = readPowerState(Date.now(), dirs);
  assert.equal(shown.rebootScheduled, true, "the refusal did not hide the schedule");
  assert.equal(shown.lastError?.detail, "the signature does not match");
  requestCancel("vitor", Date.now(), dirs);
  assert.match(fs.readFileSync(path.join(dirs.requests, "cancel-request"), "utf8"), /^action=cancel\n/);
  fs.writeFileSync(path.join(dirs.state, "last-error"), `state=rejected\nat=${at - 100}\ndetail=old\n`);
  assert.equal(readPowerState(Date.now(), dirs).lastError, null, "an error older than the schedule is not shown");
});

test("the host's files are read defensively", () => {
  assert.deepEqual(parseHostSchedule("state=scheduled\nat=1700000000\nreboot_at=1700000060\nby=vitor\n"), { state: "scheduled", at: 1700000000, rebootAt: 1700000060, by: "vitor" });
  assert.equal(parseHostSchedule("state=weird\nat=abc\n").state, "unknown");
  assert.deepEqual(parseHostError("state=rejected\nat=1\ndetail=the signature does not match\n"), { state: "rejected", at: 1, detail: "the signature does not match" });
  assert.equal(parseHostError("state=scheduled\n"), null);
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
