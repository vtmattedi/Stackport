import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingressAlias, ingressNetworkName, isReservedIngressServiceName } from "../src/shared/ingressNames";
import { applyStackportProxyNetwork } from "../src/modules/deployments/compose/networking";
import { dumpYamlDoc, loadYamlDoc } from "../src/modules/deployments/compose/yaml";
import { validateResolvedComposePolicy, type PolicyViolation } from "../src/modules/deployments/compose/policy";

const POSIX = { projectDir: "/srv/stackport/7-app", projectId: 7 };
const ingress = ingressNetworkName(7);

function compose(doc: unknown): { dir: string; read: () => any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingress-"));
  fs.writeFileSync(path.join(dir, "compose.yml"), dumpYamlDoc(doc));
  return { dir, read: () => loadYamlDoc(fs.readFileSync(path.join(dir, "compose.yml"), "utf8")) };
}

test("names: the network and alias carry the project's id", () => {
  assert.equal(ingressNetworkName(7), "stackport-ingress-7");
  assert.equal(ingressAlias(7, "web"), "sp7-web");
  assert.notEqual(ingressAlias(7, "web"), ingressAlias(8, "web"));
  assert.equal(isReservedIngressServiceName("stackport"), true);
  assert.equal(isReservedIngressServiceName("sp3-web"), true);
  assert.equal(isReservedIngressServiceName("web"), false);
});

test("rewrite: an implicit network keeps 'default' and gains the project's ingress network with its alias", async () => {
  const f = compose({ services: { web: { image: "nginx" }, db: { image: "postgres" } } });
  assert.equal((await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7)).ok, true);
  const out = f.read();
  assert.deepEqual(out.services.web.networks, { default: {}, [ingress]: { aliases: ["sp7-web"] } });
  assert.equal(out.services.db.networks, undefined, "services that are not routed are left alone");
  assert.deepEqual(out.networks[ingress], { external: true, name: ingress });
});

test("rewrite: a list of networks and an alias list both keep their entries", async () => {
  for (const networks of [["private"], { private: { aliases: ["db-client"] } }]) {
    const f = compose({ services: { web: { image: "nginx", networks } }, networks: { private: {} } });
    await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
    const out = f.read();
    assert.deepEqual(Object.keys(out.services.web.networks).sort(), ["private", ingress].sort());
    if (!Array.isArray(networks)) assert.deepEqual(out.services.web.networks.private, networks.private);
    assert.deepEqual(out.services.web.networks[ingress], { aliases: ["sp7-web"] });
  }
});

test("rewrite: running it again changes nothing", async () => {
  const f = compose({ services: { web: { image: "nginx" } } });
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  const first = fs.readFileSync(path.join(f.dir, "compose.yml"), "utf8");
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  assert.equal(fs.readFileSync(path.join(f.dir, "compose.yml"), "utf8"), first);
});

test("rewrite: the shared stackport-proxy network an older release added is taken out", async () => {
  const f = compose({
    services: { web: { image: "nginx", networks: ["default", "stackport-proxy"] }, api: { image: "x", networks: { "stackport-proxy": {} } } },
    networks: { "stackport-proxy": { external: true, name: "stackport-proxy" } },
  });
  await applyStackportProxyNetwork(f.dir, "compose.yml", ["web"], 7);
  const out = f.read();
  assert.deepEqual(Object.keys(out.services.web.networks).sort(), ["default", ingress].sort());
  assert.equal(out.services.api.networks, undefined);
  assert.deepEqual(Object.keys(out.networks), [ingress]);
});

test("rewrite: two projects' services of the same name get different aliases on different networks", async () => {
  const a = compose({ services: { web: { image: "nginx" } } });
  const b = compose({ services: { web: { image: "nginx" } } });
  await applyStackportProxyNetwork(a.dir, "compose.yml", ["web"], 7);
  await applyStackportProxyNetwork(b.dir, "compose.yml", ["web"], 8);
  assert.notDeepEqual(Object.keys(a.read().networks), Object.keys(b.read().networks));
  assert.deepEqual(a.read().services.web.networks[ingressNetworkName(7)].aliases, ["sp7-web"]);
  assert.deepEqual(b.read().services.web.networks[ingressNetworkName(8)].aliases, ["sp8-web"]);
});

const problems = (doc: unknown, context = POSIX): string[] =>
  validateResolvedComposePolicy(doc, context).violations.map((v: PolicyViolation) => `${v.service}.${v.key}`);
const resolved = (services: Record<string, unknown>, networks: Record<string, unknown> = {}) => ({ name: "7-app", services, networks });

test("policy: the project's own ingress network, with Stackport's alias, is accepted", () => {
  const doc = resolved(
    { web: { image: "x", networks: { default: null, [ingress]: { aliases: ["sp7-web"] } } } },
    { default: { name: "7-app_default" }, [ingress]: { name: ingress, external: true } },
  );
  assert.deepEqual(problems(doc), []);
});

test("policy: the shared stackport-proxy network and another project's ingress network are refused", () => {
  assert.deepEqual(problems(resolved({ web: { image: "x" } }, { p: { name: "stackport-proxy", external: true } })), ["p.external"]);
  assert.deepEqual(problems(resolved({ web: { image: "x" } }, { p: { name: ingressNetworkName(8), external: true } })), ["p.external"]);
});

test("policy: without a project id no external network is accepted, not even an ingress one", () => {
  const doc = resolved({ web: { image: "x" } }, { p: { name: ingress, external: true } });
  assert.deepEqual(problems(doc, { projectDir: POSIX.projectDir } as typeof POSIX), ["p.external"]);
});

test("policy: a service cannot give itself another service's alias on the ingress network", () => {
  const hijack = resolved({ web: { image: "x", networks: { [ingress]: { aliases: ["sp3-web", "stackport"] } } } }, { [ingress]: { name: ingress, external: true } });
  assert.deepEqual(problems(hijack), ["web.networks"]);
});

test("policy: a service named like Stackport or like an alias is refused on the ingress network, and fine off it", () => {
  const on = (name: string) => resolved({ [name]: { image: "x", networks: { [ingress]: { aliases: [ingressAlias(7, name)] } } } }, { [ingress]: { name: ingress, external: true } });
  assert.deepEqual(problems(on("stackport")), ["stackport.networks"]);
  assert.deepEqual(problems(on("sp3-web")), ["sp3-web.networks"]);
  assert.deepEqual(problems(resolved({ stackport: { image: "x" } })), [], "a private service of that name cannot be reached by nginx");
});

test("nginx and TCP proxies reach a service by its project's alias, not its plain name", async () => {
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
