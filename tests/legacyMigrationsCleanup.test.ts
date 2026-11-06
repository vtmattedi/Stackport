import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeToRemove, runCleanup, type CleanupDeps, type RecordedSource } from "../src/legacyMigrations/cleanupMounts";
import type { DockerResult } from "../src/legacyMigrations/docker";

const source: RecordedSource = { id: 1, projectId: 7, projectName: "shop", composeProject: "7-shop", sourcePath: "/app/data/repos/7-shop/data", name: "data" };
const MANAGED = "/var/lib/stackport/data/volumes/7/data";

/** `present` maps a host path to what a probe finds ("kb entries"); `mounted` is what running containers mount. */
function harness(options: { present?: Record<string, string>; mounted?: string[]; running?: boolean; rmFails?: boolean; sources?: RecordedSource[] } = {}) {
  const calls: string[][] = [];
  const removed: number[] = [];
  const present = options.present ?? { [source.sourcePath]: "100 3", [MANAGED]: "100 3" };
  const docker = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: options.running === false ? "" : "abc\n", stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: (options.mounted ?? []).join("\n") + "\n", stderr: "" };
    if (args.includes('rm -rf "/p/$TARGET"')) return options.rmFails ? { code: 1, stdout: "", stderr: "rm: busy" } : { code: 0, stdout: "", stderr: "" };
    const src = args.find((a) => a.startsWith("type=bind,src="))?.split(",")[1].slice(4) ?? "";
    const found = present[src];
    return found ? { code: 0, stdout: `${found.split(" ")[0]}\n${found.split(" ")[1]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "missing" };
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
