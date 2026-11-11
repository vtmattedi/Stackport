import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { rowToProject } from "../src/modules/projects/types";
import { INGRESS_NETWORK, isolatedAlias, isolatedNetworkName, isReservedIngressServiceName, upstreamAlias } from "../src/shared/ingressNames";
import { nthSubnet } from "../src/shared/cidr";
import { applyStackportProxyNetwork } from "../src/modules/deployments/compose/networking";
import { dumpYamlDoc, loadYamlDoc } from "../src/modules/deployments/compose/yaml";
import { validateResolvedComposePolicy } from "../src/modules/deployments/compose/policy";
import { isIngressIsolated, setIngressIsolated } from "../src/modules/ingress/isolationState";
import { isolatedSubnet, switchToIsolated, switchToShared, type IsolationDeps } from "../src/modules/ingress/isolation";
import type { DockerRun } from "../src/modules/ingress/networks";

before(() => { initializeDatabase(); });

test("names: an isolated service has its own alias and network, and that alias is reserved", () => {
  assert.equal(isolatedNetworkName(7), "stackport-iso-7");
  assert.equal(isolatedAlias(7, "web"), "iso7-web");
  assert.equal(upstreamAlias(7, "web", false), "sp7-web");
  assert.equal(upstreamAlias(7, "web", true), "iso7-web");
  assert.equal(isReservedIngressServiceName("iso3-web"), true);
  assert.equal(isReservedIngressServiceName("isolated"), false);
});

test("subnets: one /27 per project from our own range, none from the Docker pool", () => {
  assert.equal(isolatedSubnet(0, "10.212.0.0/14"), "10.212.0.0/27");
  assert.equal(isolatedSubnet(1, "10.212.0.0/14"), "10.212.0.32/27");
  assert.equal(isolatedSubnet(8, "10.212.0.0/14"), "10.212.1.0/27");
  assert.equal(isolatedSubnet(8191, "10.212.0.0/14"), "10.215.255.224/27");
  assert.equal(isolatedSubnet(8192, "10.212.0.0/14"), null, "the range holds 8192 projects");
  assert.equal(nthSubnet("10.0.0.0/27", 27, 1), null);
  assert.equal(nthSubnet("garbage", 27, 0), null);
  const seen = new Set(Array.from({ length: 500 }, (_, i) => isolatedSubnet(i, "10.212.0.0/14")));
  assert.equal(seen.size, 500, "no two projects share a subnet");
});

// ---- the Compose rewrite

function compose(doc: unknown): { dir: string; read: () => any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iso-"));
  fs.writeFileSync(path.join(dir, "compose.yml"), dumpYamlDoc(doc));
  return { dir, read: () => loadYamlDoc(fs.readFileSync(path.join(dir, "compose.yml"), "utf8")) };
}

test("rewrite: an isolated project is attached to its own network and not to the shared one, and back", async () => {
  const f = compose({ services: { web: { image: "nginx" }, db: { image: "postgres" } } });
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  assert.deepEqual(f.read().services.web.networks[INGRESS_NETWORK], { aliases: ["sp7-web"] });

  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7, true);
  let out = f.read();
  assert.deepEqual(out.services.web.networks, { default: {}, "stackport-iso-7": { aliases: ["iso7-web"] } });
  assert.deepEqual(out.networks, { "stackport-iso-7": { external: true, name: "stackport-iso-7" } });
  assert.equal(out.services.db.networks, undefined);

  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  out = f.read();
  assert.deepEqual(out.services.web.networks, { default: {}, [INGRESS_NETWORK]: { aliases: ["sp7-web"] } });
  assert.deepEqual(Object.keys(out.networks), [INGRESS_NETWORK]);
});

// ---- the policy

const resolved = (services: Record<string, unknown>, networks?: Record<string, unknown>): unknown => ({ name: "7-app", services, ...(networks ? { networks } : {}) });
const problems = (doc: unknown): string[] => validateResolvedComposePolicy(doc, { projectDir: "/srv/stackport/7-app", projectId: 7 }).violations.map((v) => `${v.service}.${v.key}`).sort();

test("policy: the project's own isolated network and alias are accepted, another project's network or an extra alias is not", () => {
  const own = resolved({ web: { image: "x", networks: { default: null, "stackport-iso-7": { aliases: ["iso7-web"] } } } }, { default: { name: "7-app_default" }, "stackport-iso-7": { external: true, name: "stackport-iso-7" } });
  assert.deepEqual(problems(own), []);

  const other = resolved({ web: { image: "x", networks: { "stackport-iso-8": { aliases: ["iso8-web"] } } } }, { "stackport-iso-8": { external: true, name: "stackport-iso-8" } });
  assert.ok(problems(other).includes("stackport-iso-8.external"), "joining another project's isolated network is refused");

  const extra = resolved({ web: { image: "x", networks: { "stackport-iso-7": { aliases: ["iso7-web", "iso8-web"] } } } }, { "stackport-iso-7": { external: true, name: "stackport-iso-7" } });
  assert.deepEqual(problems(extra), ["web.networks"]);

  const spoof = resolved({ web: { image: "x", networks: { "stackport-iso-7": { aliases: ["stackport"] } } } }, { "stackport-iso-7": { external: true, name: "stackport-iso-7" } });
  assert.deepEqual(problems(spoof), ["web.networks"]);
});

// ---- nginx follows the flag

test("nginx: an isolated project is reached by its isolated alias, a shared one by its shared alias", async () => {
  const { generateNginxConfig } = await import("../src/modules/ingress/nginx/configWriter");
  const db = getDatabase();
  const now = new Date().toISOString();
  const project = createProject({ name: "iso-nginx", sourceType: "upload" });
  db.prepare("INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port, created_at, updated_at) VALUES (?, 'iso.example.com', 0, 'web', 3000, ?, ?)").run(project.id, now, now);
  const render = async (): Promise<string> => generateNginxConfig((db.prepare("SELECT * FROM projects ORDER BY id").all() as Parameters<typeof rowToProject>[0][]).map(rowToProject));

  assert.match(await render(), new RegExp(`http://sp${project.id}-web:3000;`));
  setIngressIsolated(project.id, true);
  assert.equal(isIngressIsolated(project.id), true);
  const isolated = await render();
  assert.match(isolated, new RegExp(`http://iso${project.id}-web:3000;`));
  assert.doesNotMatch(isolated, new RegExp(`http://sp${project.id}-web:3000;`));
  setIngressIsolated(project.id, false);
  assert.match(await render(), new RegExp(`http://sp${project.id}-web:3000;`));
});

// ---- the switch, with a fake Docker

interface Fake {
  deps: IsolationDeps;
  calls: string[][];
  nginxApplied: boolean[];
  flags: boolean[];
  composeApplied: boolean[];
  tcpCount: () => number;
}

/** `reachable` decides which aliases answer, `nginxOk` what the nginx apply says, `running` how many containers exist. */
function fake(options: { reachable?: (alias: string) => boolean; nginxOk?: boolean; running?: number; createFails?: string } = {}): Fake {
  const calls: string[][] = [];
  const nginxApplied: boolean[] = [];
  const flags: boolean[] = [];
  const composeApplied: boolean[] = [];
  let networkExists = false;
  let tcp = 0;
  const docker: DockerRun = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") { if (!networkExists) throw new Error("Error: No such network: x"); return "id"; }
    if (args[0] === "network" && args[1] === "create") { if (options.createFails) throw new Error(options.createFails); networkExists = true; return ""; }
    if (args[0] === "ps") return Array.from({ length: options.running ?? 1 }, (_, i) => `c${i}`).join("\n");
    if (args[0] === "inspect") return "{}";
    return "";
  };
  const deps: IsolationDeps = {
    docker,
    probe: async (alias) => ((options.reachable ?? (() => true))(alias) ? { failure: null, detail: "" } : { failure: "name-does-not-resolve", detail: "" }),
    routes: () => [{ service: "web", port: 3000 }],
    composeProject: () => "7-app",
    setFlag: (_id, isolated) => { flags.push(isolated); },
    applyNginx: async () => { nginxApplied.push(true); return { ok: options.nginxOk ?? true, message: options.nginxOk === false ? "unknown directive" : "" }; },
    applyCompose: async (_id, isolated) => { composeApplied.push(isolated); return { ok: true, message: "" }; },
    applyTcp: async () => { tcp += 1; },
    range: "10.212.0.0/14",
  };
  return { deps, calls, nginxApplied, flags, composeApplied, tcpCount: () => tcp };
}

const isNet = (c: string[], verb: string): boolean => c[0] === "network" && c[1] === verb;

test("switch: the network gets an explicit subnet, nginx and the service join it, and only then does nginx change", async () => {
  const f = fake();
  const result = await switchToIsolated(7, f.deps);
  assert.equal(result.ok, true, result.reason);
  const create = f.calls.find((c) => isNet(c, "create"))!;
  assert.deepEqual(create.slice(0, 6), ["network", "create", "--driver", "bridge", "--subnet", "10.212.0.224/27"]);
  assert.ok(f.calls.some((c) => isNet(c, "connect") && c.includes("stackport-nginx")));
  assert.ok(f.calls.some((c) => isNet(c, "connect") && c.includes("--alias") && c.includes("iso7-web") && c.includes("stackport-iso-7")));
  assert.deepEqual(f.flags, [true]);
  assert.equal(f.nginxApplied.length, 1);
  assert.deepEqual(f.composeApplied, [true]);
  assert.equal(f.tcpCount(), 1);
  const leftShared = f.calls.findIndex((c) => isNet(c, "disconnect") && c.includes(INGRESS_NETWORK));
  assert.ok(leftShared > f.calls.findIndex((c) => isNet(c, "create")), "the shared attachment is dropped last");
});

test("switch: when the new route does not answer from nginx, nothing nginx uses is changed and the network is removed", async () => {
  const f = fake({ reachable: (alias) => !alias.startsWith("iso") });
  const result = await switchToIsolated(7, f.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /new route was not working, so nothing was changed/);
  assert.deepEqual(f.flags, [], "the flag is never set");
  assert.equal(f.nginxApplied.length, 0, "nginx is never touched");
  assert.deepEqual(f.composeApplied, []);
  assert.ok(f.calls.some((c) => isNet(c, "rm") && c[2] === "stackport-iso-7"), "the half-made network is removed");
  assert.ok(!f.calls.some((c) => isNet(c, "disconnect") && c.includes(INGRESS_NETWORK)), "the shared network is untouched");
});

test("switch: when nginx refuses the new config, the flag and the config go back", async () => {
  const f = fake({ nginxOk: false });
  const result = await switchToIsolated(7, f.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /nginx refused/);
  assert.deepEqual(f.flags, [true, false]);
  assert.equal(f.nginxApplied.length, 2, "applied once, then applied again to restore");
  assert.ok(!f.calls.some((c) => isNet(c, "disconnect") && c.includes(INGRESS_NETWORK)));
  assert.ok(f.calls.some((c) => isNet(c, "rm")));
});

test("switch: when the check after nginx switched fails, TCP proxies are moved back before the network is removed", async () => {
  let probes = 0;
  const f = fake({ reachable: () => ++probes <= 1 });
  const result = await switchToIsolated(7, f.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /After nginx switched/);
  assert.deepEqual(f.flags, [true, false]);
  assert.equal(f.tcpCount(), 2, "moved onto the network, then back");
  assert.equal(f.nginxApplied.length, 2);
  assert.ok(f.calls.some((c) => isNet(c, "rm") && c[2] === "stackport-iso-7"));
});

test("switch: a project with nothing running cannot be checked, so nothing changes", async () => {
  const f = fake({ running: 0 });
  const result = await switchToIsolated(7, f.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /None of the project's routed services is running/);
  assert.equal(f.nginxApplied.length, 0);
  assert.deepEqual(f.flags, []);
});

test("switch: a subnet Docker refuses is reported with the way out, and nothing is left behind", async () => {
  const f = fake({ createFails: "Error response from daemon: Pool overlaps with other one on this address space" });
  const result = await switchToIsolated(7, f.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /STACKPORT_ISOLATION_RANGE/);
  assert.deepEqual(f.flags, []);
});

test("switch back: the shared route is checked first, then nginx, and the isolated network is removed last", async () => {
  const f = fake();
  const result = await switchToShared(7, f.deps);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(f.flags, [false]);
  assert.deepEqual(f.composeApplied, [false]);
  const connectShared = f.calls.findIndex((c) => isNet(c, "connect") && c.includes(INGRESS_NETWORK));
  const removeIso = f.calls.findIndex((c) => isNet(c, "rm") && c[2] === "stackport-iso-7");
  assert.ok(connectShared >= 0 && removeIso > connectShared);
  assert.equal(f.tcpCount(), 1);
});

test("switch back: if the shared route is not working nothing is changed", async () => {
  const f = fake({ reachable: (alias) => alias.startsWith("iso") });
  const result = await switchToShared(7, f.deps);
  assert.equal(result.ok, false);
  assert.deepEqual(f.flags, []);
  assert.equal(f.nginxApplied.length, 0);
  assert.ok(!f.calls.some((c) => isNet(c, "rm")));
});
