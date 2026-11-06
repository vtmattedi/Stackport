import { test } from "node:test";
import assert from "node:assert/strict";
import { runVolumeMigration, type DockerResult, type VolumeMigrationDeps } from "../src/legacyMigrations/volumeMounts";

const REPO = "/app/data/repos/7-shop";
const project = { id: 7, name: "shop", composeFile: "compose.yml", repoPath: REPO, composeProject: "7-shop" };
const resolved = { services: { web: { volumes: [{ type: "bind", source: `${REPO}/data`, target: "/data" }] } } };

interface Harness { deps: VolumeMigrationDeps; calls: string[][]; made: string[]; marked: number[]; recorded: string[] }

/** `present` maps a host path to what a probe of it finds ("kb entries"). */
function harness(options: { present?: Record<string, string>; running?: boolean; resolved?: unknown | null; copyFails?: boolean; projects?: typeof project[] } = {}): Harness {
  const calls: string[][] = [];
  const made: string[] = [];
  const marked: number[] = [];
  const recorded: string[] = [];
  const docker = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: options.running ? "abc123\n" : "", stderr: "" };
    const mount = args.find((a) => a.startsWith("type=bind,src="));
    const src = mount?.split(",")[1].slice("src=".length) ?? "";
    if (args.includes("cp -a /from/. /to/")) return options.copyFails ? { code: 1, stdout: "", stderr: "cp: no space left" } : { code: 0, stdout: "", stderr: "" };
    const found = options.present?.[src];
    return found ? { code: 0, stdout: `${found.split(" ")[0]}\n${found.split(" ")[1]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no such path" };
  };
  const deps: VolumeMigrationDeps = {
    docker,
    roots: { containerDataRoot: "/app/data", hostDataRoot: "/var/lib/stackport/data" },
    listProjects: () => options.projects ?? [project],
    resolve: async () => (options.resolved === undefined ? resolved : options.resolved),
    isFile: () => false,
    helperImage: async () => "stackport-stackport:latest",
    mkdir: async (p) => { made.push(p); },
    markManaged: (id) => { marked.push(id); },
    recordCopied: (id, source, name) => { recorded.push(`${id}|${source}|${name}`); },
  };
  return { deps, calls, made, marked, recorded };
}

const copies = (h: Harness) => h.calls.filter((c) => c.includes("cp -a /from/. /to/"));

test("with nothing to migrate it says so", async () => {
  const h = harness({ projects: [] });
  assert.match((await runVolumeMigration("dry-run", h.deps)).summary, /Nothing to migrate/);
});

test("a dry run reports what it would copy and changes nothing", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "2048 12" } });
  const report = await runVolumeMigration("dry-run", h.deps);
  assert.match(report.summary, /1 project would be switched, 0 blocked/);
  assert.match(report.items.map((i) => i.label).join("\n"), /data: would copy 2\.0 MB/);
  assert.deepEqual(copies(h), []);
  assert.deepEqual(h.made, []);
  assert.deepEqual(h.marked, []);
});

test("execute copies into the managed directory, keeps the original, and switches the project", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "2048 12" } });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /1 project switched, 0 blocked/);
  assert.deepEqual(h.made, ["/app/data/volumes/7/data"]);
  assert.equal(copies(h).length, 1);
  const copy = copies(h)[0];
  assert.ok(copy.includes("type=bind,src=/app/data/repos/7-shop/data,dst=/from,readonly"), "the source is mounted read-only");
  assert.ok(copy.includes("type=bind,src=/var/lib/stackport/data/volumes/7/data,dst=/to"), "the target is the host path");
  assert.equal(copy[copy.length - 1], "cp -a /from/. /to/", "the script only copies; nothing is deleted");
  assert.deepEqual(h.marked, [7]);
  assert.deepEqual(h.recorded, [`7|${REPO}/data|data`], "where the data came from is remembered for the cleanup");
});

test("data found in two places blocks the project instead of guessing", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "10 1", "/var/lib/stackport/data/repos/7-shop/data": "20 2" } });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /0 projects switched, 1 blocked/);
  assert.deepEqual(copies(h), []);
  assert.deepEqual(h.marked, []);
});

test("a failed copy leaves the project on its old mounts", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "10 1" }, copyFails: true });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /1 blocked/);
  assert.match(report.items.map((i) => i.detail ?? "").join("\n"), /no space left/);
  assert.deepEqual(h.marked, []);
});

test("a project that cannot be resolved is blocked, not switched", async () => {
  const h = harness({ resolved: null });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /0 projects switched, 1 blocked/);
  assert.deepEqual(h.marked, []);
});

test("a mount with no data yet starts empty and the project still switches", async () => {
  const h = harness();
  const report = await runVolumeMigration("execute", h.deps);
  assert.deepEqual(h.made, ["/app/data/volumes/7/data"]);
  assert.deepEqual(copies(h), []);
  assert.deepEqual(h.marked, [7]);
  assert.equal(report.items.some((i) => /no existing data/.test(i.label)), true);
});

test("running containers produce a warning", async () => {
  const h = harness({ running: true, present: { [`${REPO}/data`]: "10 1" } });
  const report = await runVolumeMigration("dry-run", h.deps);
  assert.equal(report.items.some((i) => i.status === "warn" && /running/.test(i.label)), true);
});
