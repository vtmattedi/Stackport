import { test } from "node:test";
import assert from "node:assert/strict";
import { managedDirectoryName } from "../src/modules/deployments/compose/managedVolumes";
import { runVolumeMigration, VERIFY_SCRIPT, type DockerResult, type VolumeMigrationDeps } from "../src/modules/maintenance/migrations/volumeMounts";

const REPO = "/app/data/repos/7-shop";
const DATA_DIR = managedDirectoryName("data");
const project = { id: 7, name: "shop", composeFile: "compose.yml", repoPath: REPO, composeProject: "7-shop" };
const resolved = { services: { web: { volumes: [{ type: "bind", source: `${REPO}/data`, target: "/data" }] } } };

interface Harness { deps: VolumeMigrationDeps; calls: string[][]; made: string[]; marked: number[]; recorded: string[] }

/** `present` maps a host path to what a probe of it finds ("kb entries"). */
function harness(options: { present?: Record<string, string>; running?: boolean; resolved?: unknown | null; copyFails?: boolean; projects?: typeof project[]; daemonDown?: boolean; psFails?: boolean; verifyFails?: boolean } = {}): Harness {
  const calls: string[][] = [];
  const made: string[] = [];
  const marked: number[] = [];
  const recorded: string[] = [];
  const docker = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (options.daemonDown) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" };
    if (args[0] === "ps" && options.psFails) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (args[0] === "ps") return { code: 0, stdout: options.running ? "abc123\n" : "", stderr: "" };
    const mount = args.find((a) => a.startsWith("type=bind,src="));
    const src = mount?.split(",")[1].slice("src=".length) ?? "";
    if (args[args.length - 1] === VERIFY_SCRIPT) return options.verifyFails ? { code: 1, stdout: "Files /from/a.db and /to/a.db differ\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    if (args.includes("cp -a /from/. /to/")) return options.copyFails ? { code: 1, stdout: "", stderr: "cp: no space left" } : { code: 0, stdout: "", stderr: "" };
    const found = options.present?.[src];
    return found ? { code: 0, stdout: `${found.split(" ")[0]}\n${found.split(" ")[1]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: 'invalid mount config for type "bind": bind source path does not exist' };
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
  assert.match(report.items.map((i) => i.label).join("\n"), /data-[0-9a-f]{8}: would copy 2\.0 MB/);
  assert.deepEqual(copies(h), []);
  assert.deepEqual(h.made, []);
  assert.deepEqual(h.marked, []);
});

test("execute copies into the managed directory, keeps the original, and switches the project", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "2048 12" } });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /1 project switched, 0 blocked/);
  assert.deepEqual(h.made, [`/app/data/volumes/7/${DATA_DIR}`]);
  assert.equal(copies(h).length, 1);
  const copy = copies(h)[0];
  assert.ok(copy.includes("type=bind,src=/app/data/repos/7-shop/data,dst=/from,readonly"), "the source is mounted read-only");
  assert.ok(copy.includes(`type=bind,src=/var/lib/stackport/data/volumes/7/${DATA_DIR},dst=/to`), "the target is the host path");
  assert.equal(copy[copy.length - 1], "cp -a /from/. /to/", "the script only copies; nothing is deleted");
  assert.deepEqual(h.marked, [7]);
  assert.deepEqual(h.recorded, [`7|${REPO}/data|${DATA_DIR}`], "where the data came from is remembered for the cleanup");
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
  assert.deepEqual(h.made, [`/app/data/volumes/7/${DATA_DIR}`]);
  assert.deepEqual(copies(h), []);
  assert.deepEqual(h.marked, [7]);
  assert.equal(report.items.some((i) => /no existing data/.test(i.label)), true);
});

test("a Docker error while looking for data is not read as 'no data': the project is blocked, not switched to an empty directory", async () => {
  const h = harness({ daemonDown: true });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /0 projects switched, 1 blocked/);
  assert.deepEqual(h.made, [], "no empty directory was prepared");
  assert.deepEqual(h.marked, []);
  assert.match(report.items.map((i) => i.detail ?? "").join("\n"), /Cannot connect to the Docker daemon/);
});

test("the copy is verified against the original, read-only, before the project is switched", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "2048 12" } });
  await runVolumeMigration("execute", h.deps);
  const verify = h.calls.find((c) => c[c.length - 1] === VERIFY_SCRIPT);
  assert.ok(verify, "a verification ran");
  assert.ok(verify.includes(`type=bind,src=/var/lib/stackport/data/volumes/7/${DATA_DIR},dst=/to,readonly`), "both sides read-only");
  assert.deepEqual(h.marked, [7]);
});

test("a copy that does not match the original is not switched to and is not recorded", async () => {
  const h = harness({ present: { [`${REPO}/data`]: "2048 12" }, verifyFails: true });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /1 blocked/);
  assert.match(report.items.map((i) => i.label + (i.detail ?? "")).join("\n"), /does not match the original[\s\S]*differ/);
  assert.deepEqual(h.marked, []);
  assert.deepEqual(h.recorded, [], "so the cleanup can never delete an original whose copy was not verified");
});

test("a project whose containers are running is not migrated, in the dry run or the execute", async () => {
  for (const mode of ["dry-run", "execute"] as const) {
    const h = harness({ running: true, present: { [`${REPO}/data`]: "10 1" } });
    const report = await runVolumeMigration(mode, h.deps);
    assert.match(report.summary, /0 projects (would be )?switched, 1 blocked/, mode);
    assert.match(report.items[0].detail ?? "", /containers are running/, mode);
    assert.deepEqual(copies(h), [], mode);
    assert.deepEqual(h.made, [], mode);
    assert.deepEqual(h.marked, [], mode);
  }
});

test("when the container listing fails the project is not migrated either", async () => {
  const h = harness({ psFails: true, present: { [`${REPO}/data`]: "10 1" } });
  const report = await runVolumeMigration("execute", h.deps);
  assert.match(report.summary, /1 blocked/);
  assert.match(report.items[0].detail ?? "", /Could not tell whether the project is running/);
  assert.deepEqual(h.marked, []);
});
