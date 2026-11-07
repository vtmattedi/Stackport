import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeToRemove, mountsPathOrInside, ORIGINAL_NOT_NEWER_SCRIPT, runCleanup, type CleanupDeps, type RecordedSource } from "../src/modules/maintenance/migrations/cleanupMounts";
import { probeDirectory, type DockerResult } from "../src/modules/maintenance/migrations/docker";

const source: RecordedSource = { id: 1, projectId: 7, projectName: "shop", composeProject: "7-shop", sourcePath: "/app/data/repos/7-shop/data", name: "data" };
const MANAGED = "/var/lib/stackport/data/volumes/7/data";

/** `present` maps a host path to what a probe finds ("kb entries"); `mounted` is what running containers mount. */
function harness(options: { present?: Record<string, string>; mounted?: string[]; running?: boolean; rmFails?: boolean; sources?: RecordedSource[]; psFails?: boolean; probeErrorOn?: string; coverageFails?: boolean } = {}) {
  const calls: string[][] = [];
  const removed: number[] = [];
  const present = options.present ?? { [source.sourcePath]: "100 3", [MANAGED]: "100 3" };
  const docker = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args[0] === "ps" && options.psFails) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (options.probeErrorOn && args.some((a) => a.includes(`src=${options.probeErrorOn},`))) return { code: 125, stdout: "", stderr: "Unable to find image 'img' locally" };
    if (args[0] === "ps") return { code: 0, stdout: options.running === false ? "" : "abc\n", stderr: "" };
    if (args.includes(ORIGINAL_NOT_NEWER_SCRIPT)) return options.coverageFails ? { code: 1, stdout: "newer in the original than in the managed copy: ./a.db\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: (options.mounted ?? []).join("\n") + "\n", stderr: "" };
    if (args.includes('rm -rf "/p/$TARGET"')) return options.rmFails ? { code: 1, stdout: "", stderr: "rm: busy" } : { code: 0, stdout: "", stderr: "" };
    const src = args.find((a) => a.startsWith("type=bind,src="))?.split(",")[1].slice(4) ?? "";
    const found = present[src];
    return found ? { code: 0, stdout: `${found.split(" ")[0]}\n${found.split(" ")[1]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: 'invalid mount config for type "bind": bind source path does not exist' };
  };
  const deps: CleanupDeps = {
    docker,
    roots: { containerDataRoot: "/app/data", hostDataRoot: "/var/lib/stackport/data" },
    listSources: () => options.sources ?? [source],
    helperImage: async () => "img",
    markRemoved: (id) => { removed.push(id); },
  };
  return { deps, calls, removed };
}
const deletions = (calls: string[][]) => calls.filter((c) => c.includes('rm -rf "/p/$TARGET"'));

test("paths too close to the root are never removed", () => {
  for (const bad of ["/", "/app", "/app/data", "relative/path", "/app/../etc/x", "/app/data//x/", "/a/./b/c"]) assert.equal(isSafeToRemove(bad), false, bad);
  assert.equal(isSafeToRemove("/app/data/repos/7-shop/data"), true);
});

test("with nothing recorded there is nothing to clean up", async () => {
  assert.match((await runCleanup("dry-run", harness({ sources: [] }).deps)).summary, /Nothing to clean up/);
});

test("a dry run lists what it would remove and deletes nothing", async () => {
  const h = harness({ running: false });
  const report = await runCleanup("dry-run", h.deps);
  assert.match(report.summary, /1 directory would be removed, 0 skipped/);
  assert.deepEqual(deletions(h.calls), []);
  assert.deepEqual(h.removed, []);
});

test("execute removes only the original, from its parent, and records it", async () => {
  const h = harness({ running: false });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.summary, /1 directory removed/);
  const [call] = deletions(h.calls);
  assert.ok(call.includes("type=bind,src=/app/data/repos/7-shop,dst=/p"), "the parent is mounted, not the data itself");
  assert.ok(call.includes("TARGET=data"));
  assert.deepEqual(h.removed, [1]);
});

test("an empty or missing managed copy protects the original", async () => {
  for (const present of [{ [source.sourcePath]: "100 3" }, { [source.sourcePath]: "100 3", [MANAGED]: "0 0" }]) {
    const h = harness({ present, running: false });
    const report = await runCleanup("execute", h.deps);
    assert.match(report.summary, /0 directories removed, 1 skipped/);
    assert.deepEqual(deletions(h.calls), []);
    assert.deepEqual(h.removed, []);
  }
});

test("a running container that still mounts the original blocks removal", async () => {
  const h = harness({ mounted: [source.sourcePath, "/other"] });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.items[0].detail ?? "", /still mounts/);
  assert.deepEqual(deletions(h.calls), []);
});

test("running containers that mount something else do not block", async () => {
  const h = harness({ mounted: [MANAGED] });
  assert.match((await runCleanup("execute", h.deps)).summary, /1 directory removed/);
});

test("an original that is already gone is just marked done", async () => {
  const h = harness({ present: { [MANAGED]: "5 1" }, running: false });
  const report = await runCleanup("execute", h.deps);
  assert.deepEqual(h.removed, [1]);
  assert.equal(report.items[0].status, "info");
});

test("a failed container listing blocks removal instead of counting as 'nothing running'", async () => {
  const h = harness({ psFails: true });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.items[0].detail ?? "", /Could not list the containers/);
  assert.deepEqual(deletions(h.calls), []);
  assert.deepEqual(h.removed, []);
});

test("a probe that fails for a reason other than 'missing' is not read as 'already gone'", async () => {
  const h = harness({ probeErrorOn: source.sourcePath, running: false });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.items[0].detail ?? "", /Could not look at .*Unable to find image/);
  assert.deepEqual(h.removed, [], "the record is kept so the cleanup can be run again");
});

test("a managed copy that cannot be inspected protects the original", async () => {
  const h = harness({ probeErrorOn: MANAGED, running: false });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.items[0].detail ?? "", /Could not look at the managed copy/);
  assert.deepEqual(deletions(h.calls), []);
});

test("an unsafe recorded path is refused", async () => {
  const h = harness({ sources: [{ ...source, sourcePath: "/app" }] });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.items[0].detail ?? "", /Refusing/);
  assert.deepEqual(h.calls.filter((c) => c[0] === "run"), []);
});

test("a failed removal is reported and not recorded", async () => {
  const h = harness({ running: false, rmFails: true });
  const report = await runCleanup("execute", h.deps);
  assert.match(report.items[0].detail ?? "", /rm: busy/);
  assert.deepEqual(h.removed, []);
});

test("probeDirectory tells 'missing' from 'could not tell'", async () => {
  const run = (code: number, stdout: string, stderr: string) => probeDirectory(async () => ({ code, stdout, stderr }), "img", "/x");
  assert.deepEqual(await run(0, "12\n3\n", ""), { state: "present", kb: 12, entries: 3 });
  assert.deepEqual(await run(125, "", 'invalid mount config for type "bind": bind source path does not exist: /x'), { state: "missing" });
  assert.deepEqual(await run(125, "", "docker: error response from daemon: no such file or directory"), { state: "missing" });
  const error = await run(125, "", "Cannot connect to the Docker daemon\nIs it running?");
  assert.deepEqual(error, { state: "error", detail: "Cannot connect to the Docker daemon" });
  assert.equal((await run(1, "", "")).state, "error");
});

test("every container on the host is looked at, stopped ones included, not just the project's", async () => {
  const h = harness({ running: false });
  await runCleanup("execute", h.deps);
  assert.deepEqual(h.calls.find((c) => c[0] === "ps"), ["ps", "-aq"]);
});

test("a container that mounts something inside the original blocks removal; one that mounts a parent does not", async () => {
  const inside = harness({ mounted: [`${source.sourcePath}/uploads`] });
  assert.match((await runCleanup("execute", inside.deps)).items[0].detail ?? "", /still mounts/);
  assert.deepEqual(deletions(inside.calls), []);
  const parent = harness({ mounted: ["/app/data"] });
  assert.match((await runCleanup("execute", parent.deps)).summary, /1 directory removed/);
  assert.equal(mountsPathOrInside(["/app/data/repos/7-shop/data2"], source.sourcePath), false, "a sibling with the same prefix is not inside");
});

test("an original that holds something the managed copy does not cover is kept, in the dry run too", async () => {
  for (const mode of ["dry-run", "execute"] as const) {
    const h = harness({ running: false, coverageFails: true });
    const report = await runCleanup(mode, h.deps);
    assert.match(report.summary, /0 directories (would be )?removed, 1 skipped/, mode);
    assert.match(report.items[0].detail ?? "", /not covered by the managed copy.*newer in the original/, mode);
    assert.deepEqual(deletions(h.calls), [], mode);
    assert.deepEqual(h.removed, [], mode);
  }
});

test("the coverage check mounts both directories read-only and runs before anything is deleted", async () => {
  const h = harness({ running: false });
  await runCleanup("execute", h.deps);
  const check = h.calls.find((c) => c.includes(ORIGINAL_NOT_NEWER_SCRIPT))!;
  assert.ok(check.includes(`type=bind,src=${source.sourcePath},dst=/from,readonly`));
  assert.ok(check.includes(`type=bind,src=${MANAGED},dst=/to,readonly`));
  assert.ok(h.calls.indexOf(check) < h.calls.findIndex((c) => c.includes('rm -rf "/p/$TARGET"')));
});

/** The check script itself, against real directories. It needs a POSIX sh, so it runs on Linux and macOS. */
const skipShell = process.platform === "win32" ? "needs a POSIX shell" : false;
function checkTrees(setup: (from: string, to: string) => void): { code: number | null; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-"));
  try {
    const from = path.join(root, "from"); const to = path.join(root, "to");
    fs.mkdirSync(from); fs.mkdirSync(to);
    setup(from, to);
    const run = spawnSync("sh", ["-c", ORIGINAL_NOT_NEWER_SCRIPT, "sh", from, to], { encoding: "utf8" });
    return { code: run.status, out: run.stdout };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const put = (dir: string, name: string, content: string, mtimeSec?: number) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
};

test("check script: identical trees pass, and a managed copy that moved on (newer) passes", { skip: skipShell }, () => {
  assert.equal(checkTrees((from, to) => { put(from, "a.db", "x"); put(to, "a.db", "x"); }).code, 0);
  assert.equal(checkTrees((from, to) => { put(from, "a.db", "old", 1000); put(to, "a.db", "newer data", 2000); put(to, "extra.txt", "only in the copy"); }).code, 0);
});

test("check script: a file missing from the copy, or newer in the original, fails", { skip: skipShell }, () => {
  const missing = checkTrees((from, to) => { put(from, "sub/a.db", "x"); fs.mkdirSync(path.join(to, "sub")); });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /missing from the managed copy: \.\/sub\/a\.db/);
  const newer = checkTrees((from, to) => { put(from, "a.db", "written after the revert", 3000); put(to, "a.db", "old", 1000); });
  assert.equal(newer.code, 1);
  assert.match(newer.out, /newer in the original/);
});

test("check script: links are compared by target", { skip: skipShell }, () => {
  assert.equal(checkTrees((from, to) => { fs.symlinkSync("target", path.join(from, "l")); fs.symlinkSync("target", path.join(to, "l")); }).code, 0);
  assert.equal(checkTrees((from, to) => { fs.symlinkSync("target", path.join(from, "l")); fs.symlinkSync("other", path.join(to, "l")); }).code, 1);
});
