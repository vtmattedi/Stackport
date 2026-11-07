import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INGRESS_NETWORK, ingressAlias, isReservedIngressServiceName, legacyIngressNetworkName } from "../src/shared/ingressNames";
import { applyStackportProxyNetwork, connectRunningProxyServices } from "../src/modules/deployments/compose/networking";
import { dumpYamlDoc, loadYamlDoc } from "../src/modules/deployments/compose/yaml";
import { validateResolvedComposePolicy, type PolicyViolation } from "../src/modules/deployments/compose/policy";
import { ensureSharedIngressNetwork, removeIngressNetwork, removeLegacyIngressNetworks, type DockerRun } from "../src/modules/ingress/networks";
import { tcpProxyIsOnSharedNetwork } from "../src/modules/ingress/tcp";

const POSIX = { projectDir: "/srv/stackport/7-app", projectId: 7 };

function compose(doc: unknown): { dir: string; read: () => any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingress-"));
  fs.writeFileSync(path.join(dir, "compose.yml"), dumpYamlDoc(doc));
  return { dir, read: () => loadYamlDoc(fs.readFileSync(path.join(dir, "compose.yml"), "utf8")) };
}

test("names: nginx reaches a service by an alias that carries the project's id", () => {
  assert.equal(INGRESS_NETWORK, "stackport-proxy");
  assert.equal(ingressAlias(7, "web"), "sp7-web");
  assert.notEqual(ingressAlias(7, "web"), ingressAlias(8, "web"));
  assert.equal(legacyIngressNetworkName(7), "stackport-ingress-7");
  assert.equal(isReservedIngressServiceName("stackport"), true);
  assert.equal(isReservedIngressServiceName("sp3-web"), true);
  assert.equal(isReservedIngressServiceName("web"), false);
});

// ---- the Compose rewrite

test("rewrite: an implicit network keeps 'default' and gains the shared network with the project's alias", async () => {
  const f = compose({ services: { web: { image: "nginx" }, db: { image: "postgres" } } });
  assert.equal((await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7)).ok, true);
  const out = f.read();
  assert.deepEqual(out.services.web.networks, { default: {}, [INGRESS_NETWORK]: { aliases: ["sp7-web"] } });
  assert.equal(out.services.db.networks, undefined, "services that are not routed are left alone");
  assert.deepEqual(out.networks[INGRESS_NETWORK], { external: true, name: INGRESS_NETWORK });
});

test("rewrite: a list of networks and an alias list both keep their entries", async () => {
  for (const networks of [["private"], { private: { aliases: ["db-client"] } }]) {
    const f = compose({ services: { web: { image: "nginx", networks } }, networks: { private: {} } });
    await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
    const out = f.read();
    assert.deepEqual(Object.keys(out.services.web.networks).sort(), ["private", INGRESS_NETWORK].sort());
    if (!Array.isArray(networks)) assert.deepEqual(out.services.web.networks.private, networks.private);
    assert.deepEqual(out.services.web.networks[INGRESS_NETWORK], { aliases: ["sp7-web"] });
  }
});

test("rewrite: running it again changes nothing", async () => {
  const f = compose({ services: { web: { image: "nginx" } } });
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  const first = fs.readFileSync(path.join(f.dir, "compose.yml"), "utf8");
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  assert.equal(fs.readFileSync(path.join(f.dir, "compose.yml"), "utf8"), first);
});

test("rewrite: a per-project network that 1.3.0 wrote into the file is taken out", async () => {
  const f = compose({
    services: { web: { image: "nginx", networks: { default: {}, "stackport-ingress-7": { aliases: ["sp7-web"] } } }, api: { image: "x", networks: ["stackport-ingress-7"] } },
    networks: { "stackport-ingress-7": { external: true, name: "stackport-ingress-7" } },
  });
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  const out = f.read();
  assert.deepEqual(Object.keys(out.services.web.networks).sort(), ["default", INGRESS_NETWORK].sort());
  assert.equal(out.services.api.networks, undefined);
  assert.deepEqual(Object.keys(out.networks), [INGRESS_NETWORK]);
});

test("rewrite: an alias list the file declared on the shared network is replaced by Stackport's", async () => {
  const f = compose({ services: { web: { image: "nginx", networks: { [INGRESS_NETWORK]: { aliases: ["sp3-web", "stackport"] } } } }, networks: { [INGRESS_NETWORK]: { external: true, name: INGRESS_NETWORK } } });
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  assert.deepEqual(f.read().services.web.networks[INGRESS_NETWORK], { aliases: ["sp7-web"] });
});

test("rewrite: two projects' services of the same name get different aliases on the one network", async () => {
  const a = compose({ services: { web: { image: "nginx" } } });
  const b = compose({ services: { web: { image: "nginx" } } });
  await applyStackportProxyNetwork(a.dir, "compose.yml", ["web"], 7);
  await applyStackportProxyNetwork(b.dir, "compose.yml", ["web"], 8);
  assert.deepEqual(a.read().services.web.networks[INGRESS_NETWORK].aliases, ["sp7-web"]);
  assert.deepEqual(b.read().services.web.networks[INGRESS_NETWORK].aliases, ["sp8-web"]);
});

// ---- moving running containers

type Nets = Record<string, { Aliases?: string[] | null }>;

/** A Docker with a few containers; records the network calls. A container id maps to its networks. */
function fakeDocker(containers: Record<string, Nets>, byService: Record<string, string[]>, options: { failConnect?: boolean } = {}) {
  const calls: string[][] = [];
  const run: DockerRun = async (args) => {
    calls.push(args);
    if (args[0] === "ps") {
      const service = args.find((a) => a.startsWith("label=com.docker.compose.service="))!.split("=")[2];
      return (byService[service] ?? []).join("\n");
    }
    if (args[0] === "inspect") return JSON.stringify(containers[args[args.length - 1]]);
    if (args[1] === "connect") {
      if (options.failConnect) throw new Error("Error response from daemon: all predefined address pools have been fully subnetted");
      const id = args[args.length - 1];
      const aliases = args.flatMap((a, i) => (a === "--alias" ? [args[i + 1]] : []));
      containers[id][args[args.length - 2]] = { Aliases: aliases };
      return "";
    }
    if (args[1] === "disconnect") { delete containers[args[3]][args[2]]; return ""; }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { run, calls, containers };
}
const changes = (calls: string[][]) => calls.filter((c) => c[0] === "network").map((c) => c.join(" "));

test("move: a service from 1.3.0 is put on the shared network first and only then taken off its per-project one", async () => {
  const f = fakeDocker({ c1: { "7-shop_default": {}, "stackport-ingress-7": { Aliases: ["sp7-web"] } } }, { web: ["c1"] });
  assert.equal(await connectRunningProxyServices(7, "7-shop", ["web"], f.run), 1);
  assert.deepEqual(changes(f.calls), [
    "network connect --alias sp7-web --alias web stackport-proxy c1",
    "network disconnect stackport-ingress-7 c1",
  ]);
  assert.deepEqual(Object.keys(f.containers["c1"]).sort(), ["7-shop_default", "stackport-proxy"]);
});

test("move: a service still on the shared network under its plain name is reconnected with the alias", async () => {
  const f = fakeDocker({ c1: { "7-shop_default": {}, "stackport-proxy": { Aliases: ["web"] } } }, { web: ["c1"] });
  await connectRunningProxyServices(7, "7-shop", ["web"], f.run);
  assert.deepEqual(changes(f.calls), [
    "network disconnect stackport-proxy c1",
    "network connect --alias sp7-web --alias web stackport-proxy c1",
  ]);
  assert.deepEqual(f.containers["c1"]["stackport-proxy"].Aliases, ["sp7-web", "web"]);
});

test("move: a service already in place is left alone", async () => {
  const f = fakeDocker({ c1: { "stackport-proxy": { Aliases: ["sp7-web", "web"] } } }, { web: ["c1"] });
  assert.equal(await connectRunningProxyServices(7, "7-shop", ["web"], f.run), 1);
  assert.deepEqual(changes(f.calls), []);
});

test("move: a service with no running container is not an error", async () => {
  const f = fakeDocker({}, {});
  assert.equal(await connectRunningProxyServices(7, "7-shop", ["web"], f.run), 0);
});

test("move: a Docker error is raised, so the project is reported as failed", async () => {
  const f = fakeDocker({ c1: { "7-shop_default": {} } }, { web: ["c1"] }, { failConnect: true });
  await assert.rejects(connectRunningProxyServices(7, "7-shop", ["web"], f.run), /fully subnetted/);
});

// ---- the shared network and the clean-up of 1.3.0's networks

test("the shared network is created only when it is missing", async () => {
  const calls: string[][] = [];
  await ensureSharedIngressNetwork(async (a) => { calls.push(a); return "id"; });
  assert.deepEqual(calls.map((c) => c[1]), ["inspect"]);
  const created: string[][] = [];
  await ensureSharedIngressNetwork(async (a) => { created.push(a); if (a[1] === "inspect") throw new Error("Error: No such network: stackport-proxy"); return ""; });
  assert.deepEqual(created.map((c) => c[1]), ["inspect", "create"]);
});

test("clean-up: per-project networks with only nginx on them are removed; one with another container is kept", async () => {
  const members: Record<string, string> = {
    "stackport-ingress-1": "stackport-nginx ",
    "stackport-ingress-2": "stackport-nginx 2-blog-web-1 ",
    "stackport-ingress-3": "",
    "stackport-ingress-4": "stackport-nginx ",
  };
  const calls: string[] = [];
  const run: DockerRun = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "ls") return ["bridge", "stackport-proxy", ...Object.keys(members)].join("\n");
    if (args[1] === "inspect") return members[args[2]];
    if (args[1] === "rm" && args[2] === "stackport-ingress-4") throw new Error("Error response from daemon: network has active endpoints");
    return "";
  };
  const result = await removeLegacyIngressNetworks(run);
  assert.deepEqual(result.removed, ["stackport-ingress-1", "stackport-ingress-3"]);
  assert.deepEqual(result.kept.map((k) => k.name), ["stackport-ingress-2", "stackport-ingress-4"]);
  assert.match(result.kept[0].reason, /2-blog-web-1/);
  assert.ok(calls.indexOf("network disconnect --force stackport-ingress-1 stackport-nginx") < calls.indexOf("network rm stackport-ingress-1"), "nginx is taken off before the network goes");
  assert.equal(calls.some((c) => c.includes("stackport-proxy") && c.startsWith("network rm")), false, "the shared network is never removed");
  assert.equal(calls.some((c) => c.includes("2-blog") && c.startsWith("network rm")), false);
});

test("clean-up never throws, whatever Docker says", async () => {
  const result = await removeLegacyIngressNetworks(async () => { throw new Error("Cannot connect to the Docker daemon"); });
  assert.deepEqual(result, { removed: [], kept: [] });
});

test("clean-up for a deleted project touches only that project's network", async () => {
  const calls: string[] = [];
  await removeIngressNetwork(7, async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "ls") return "stackport-ingress-7\nstackport-ingress-70";
    return "";
  });
  assert.ok(calls.includes("network rm stackport-ingress-7"));
  assert.equal(calls.some((c) => c.includes("stackport-ingress-70") && c !== "network ls --format {{.Name}}"), false);
});

test("a TCP proxy from 1.3.0 is not on the shared network, so it is recreated", () => {
  assert.equal(tcpProxyIsOnSharedNetwork({ "stackport-ingress-7": {} }), false);
  assert.equal(tcpProxyIsOnSharedNetwork({ "stackport-proxy": {} }), true);
  assert.equal(tcpProxyIsOnSharedNetwork(undefined), false);
});

// ---- policy

const problems = (doc: unknown, context: { projectDir: string; projectId?: number } = POSIX): string[] =>
  validateResolvedComposePolicy(doc, context).violations.map((v: PolicyViolation) => `${v.service}.${v.key}`);
const resolved = (services: Record<string, unknown>, networks: Record<string, unknown> = {}) => ({ name: "7-app", services, networks });

test("policy: the shared network, with Stackport's alias, is accepted", () => {
  const doc = resolved(
    { web: { image: "x", networks: { default: null, [INGRESS_NETWORK]: { aliases: ["sp7-web"] } } } },
    { default: { name: "7-app_default" }, [INGRESS_NETWORK]: { name: INGRESS_NETWORK, external: true } },
  );
  assert.deepEqual(problems(doc), []);
  assert.deepEqual(problems(doc, { projectDir: POSIX.projectDir }), [], "and without a project id");
});

test("policy: any other existing network is refused, including a per-project one from 1.3.0", () => {
  assert.deepEqual(problems(resolved({ web: { image: "x" } }, { p: { name: "stackport-ingress-7", external: true } })), ["p.external"]);
  assert.deepEqual(problems(resolved({ web: { image: "x" } }, { p: { name: "stackport_default", external: true } })), ["p.external"]);
});

test("policy: a service cannot give itself another service's alias on the shared network", () => {
  const hijack = resolved({ web: { image: "x", networks: { [INGRESS_NETWORK]: { aliases: ["sp3-web", "stackport"] } } } }, { [INGRESS_NETWORK]: { name: INGRESS_NETWORK, external: true } });
  assert.deepEqual(problems(hijack), ["web.networks"]);
});

test("policy: a service named like Stackport or like an alias is refused on the shared network, and fine off it", () => {
  const on = (name: string) => resolved({ [name]: { image: "x", networks: { [INGRESS_NETWORK]: { aliases: [ingressAlias(7, name)] } } } }, { [INGRESS_NETWORK]: { name: INGRESS_NETWORK, external: true } });
  assert.deepEqual(problems(on("stackport")), ["stackport.networks"]);
  assert.deepEqual(problems(on("sp3-web")), ["sp3-web.networks"]);
  assert.deepEqual(problems(resolved({ stackport: { image: "x" } })), [], "a private service of that name cannot be reached by nginx");
});

test("nginx reaches a service by its project's alias, not its plain name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-"));
  process.env["NGINX_PATH"] = dir;
  const { initializeDatabase, getDatabase } = await import("../src/config/database");
  const { generateNginxConfig } = await import("../src/modules/ingress/nginx/configWriter");
  const { createProject } = await import("../src/modules/projects/operations");
  const { rowToProject } = await import("../src/modules/projects/types");
  initializeDatabase();
  const db = getDatabase();
  const now = new Date().toISOString();
  const one = createProject({ name: "shop-one", sourceType: "upload" });
  const two = createProject({ name: "shop-two", sourceType: "upload" });
  for (const [project, domain] of [[one, "one.example.com"], [two, "two.example.com"]] as const) {
    db.prepare("INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port, created_at, updated_at) VALUES (?, ?, 0, 'web', 3000, ?, ?)")
      .run(project.id, domain, now, now);
  }
  const rows = db.prepare("SELECT * FROM projects ORDER BY id").all() as Parameters<typeof rowToProject>[0][];
  const config = await generateNginxConfig(rows.map(rowToProject));
  assert.match(config, new RegExp(`set \\$stackport_upstream http://sp${one.id}-web:3000;`));
  assert.match(config, new RegExp(`set \\$stackport_upstream http://sp${two.id}-web:3000;`));
  assert.doesNotMatch(config, /http:\/\/web:3000/, "the plain name is ambiguous between the two projects");
});
