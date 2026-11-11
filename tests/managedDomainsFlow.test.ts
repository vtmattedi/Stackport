import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { createProject, updateProject } from "../src/modules/projects/operations";
import { addProjectDomain, getProjectDomain, listProjectDomains, setProjectDomainRoute, setProjectDomainSsl } from "../src/modules/ingress/domains";
import {
  addManagedDomain, addManagedProjectDomain, getDefaultManagedDomain, listManagedDomains, renameProjectHostname, reserveHostnameForProject, routeReservedHostname, type RenameDeps,
} from "../src/modules/ingress/managedDomains";
import app from "../src/app";

let server: Server;
let base: string;
let token: string;

before(async () => {
  initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = issueAuthToken("admin");
});
after(() => { server.close(); });

function reset(): void {
  getDatabase().prepare("DELETE FROM project_domains").run();
  getDatabase().prepare("DELETE FROM managed_domains").run();
}
const project = (name: string): number => createProject({ name, sourceType: "upload" }).id;
const call = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- a hostname for a new project

test("a new project reserves <name>.<default domain>, unrouted, with SSL off; a taken label gets a number", () => {
  reset();
  assert.equal(reserveHostnameForProject(project("none-yet"), "none-yet"), null, "with no managed domain nothing is reserved");
  addManagedDomain("example.com");
  const first = reserveHostnameForProject(project("My Shop"), "My Shop")!;
  assert.deepEqual([first.domain, first.service, first.containerPort, first.useSsl, first.label], ["my-shop.example.com", "", null, false, "my-shop"]);
  assert.equal(reserveHostnameForProject(project("my shop"), "my shop")?.domain, "my-shop-2.example.com");
  assert.equal(reserveHostnameForProject(project("my-shop"), "my-shop")?.domain, "my-shop-3.example.com");
});

test("over HTTP, creating a project reserves its hostname, and having no base domain never fails the creation", async () => {
  reset();
  addManagedDomain("example.com");
  const res = await call("POST", "/projects", { name: "Over Http", githubRepo: "o/r" });
  assert.equal(res.status, 201);
  const id = ((await res.json()) as { id: number }).id;
  assert.deepEqual(listProjectDomains(id).map((d) => [d.domain, d.service]), [["over-http.example.com", ""]]);
  getDatabase().prepare("DELETE FROM managed_domains").run();
  assert.equal((await call("POST", "/projects", { name: "No Domain", githubRepo: "o/r2" })).status, 201);
});

test("the reserved hostname is routed only when the Compose file declares exactly one routable port", () => {
  reset();
  addManagedDomain("example.com");
  const one = project("route-one");
  reserveHostnameForProject(one, "route-one");
  assert.equal(routeReservedHostname(one, []), null);
  assert.equal(routeReservedHostname(one, [{ service: "web", containerPort: 80 }, { service: "api", containerPort: 8080 }]), null, "two ports: guessing is how traffic reaches the wrong service");
  assert.deepEqual(listProjectDomains(one).map((d) => d.service), [""]);
  const routed = routeReservedHostname(one, [{ service: "web", containerPort: 80 }]);
  assert.deepEqual([routed?.service, routed?.containerPort], ["web", 80]);
  assert.equal(routeReservedHostname(one, [{ service: "other", containerPort: 1 }]), null, "an already routed hostname is left alone");

  const two = project("route-two");
  addManagedProjectDomain(two, getDefaultManagedDomain()!.id, "a");
  addManagedProjectDomain(two, getDefaultManagedDomain()!.id, "b");
  assert.equal(routeReservedHostname(two, [{ service: "web", containerPort: 80 }]), null, "two unrouted hostnames: no way to know which");
  const unmanaged = project("route-unmanaged");
  addProjectDomain(unmanaged, "plain.org");
  assert.equal(routeReservedHostname(unmanaged, [{ service: "web", containerPort: 80 }]), null, "an unmanaged hostname is never routed by itself");
});

test("renaming a project does not rename its hostname", () => {
  reset();
  addManagedDomain("example.com");
  const id = project("keeps-name");
  reserveHostnameForProject(id, "keeps-name");
  updateProject(id, { name: "renamed" });
  assert.deepEqual(listProjectDomains(id).map((d) => d.domain), ["keeps-name.example.com"]);
});

// ---- renaming a hostname

/** Records every call in order, with the hostnames that existed at that moment. */
function harness(options: { nginx?: (call: number) => boolean; cert?: boolean } = {}): { deps: RenameDeps; log: string[]; projectId: number; oldId: number } {
  reset();
  const baseDomain = addManagedDomain("example.com");
  const projectId = project("rename-me");
  const old = addManagedProjectDomain(projectId, baseDomain.id, "old", "web", 3000);
  const log: string[] = [];
  let applies = 0;
  const snapshot = (): string => listProjectDomains(projectId).map((d) => `${d.domain}${d.useSsl ? "(ssl)" : ""}`).sort().join(",");
  const deps: RenameDeps = {
    applyNginx: async () => { applies += 1; log.push(`nginx#${applies} [${snapshot()}]`); return (options.nginx?.(applies) ?? true) ? { ok: true, message: "" } : { ok: false, message: "unknown directive" }; },
    issueCertificate: async (domain) => { log.push(`cert ${domain} [${snapshot()}]`); return options.cert === false ? { ok: false, message: "rate limited" } : { ok: true, message: "" }; },
  };
  return { deps, log, projectId, oldId: old.id };
}

test("rename without SSL: the new hostname is routed first, and only then is the old one removed", async () => {
  const h = harness();
  const result = await renameProjectHostname(h.projectId, h.oldId, { managedDomainId: listManagedDomains()[0].id, label: "fresh" }, h.deps);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.log, ["nginx#1 [fresh.example.com,old.example.com]", "nginx#2 [fresh.example.com]"], "both exist while nginx first applies; the old one is gone only afterwards");
  assert.deepEqual(listProjectDomains(h.projectId).map((d) => [d.domain, d.service, d.containerPort, d.label]), [["fresh.example.com", "web", 3000, "fresh"]]);
});

test("rename with SSL: a certificate is issued for the new name before the old one is removed", async () => {
  const h = harness();
  setProjectDomainSsl(h.projectId, h.oldId, true);
  const result = await renameProjectHostname(h.projectId, h.oldId, { managedDomainId: listManagedDomains()[0].id, label: "fresh" }, h.deps);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.log, [
    "nginx#1 [fresh.example.com,old.example.com(ssl)]",
    "cert fresh.example.com [fresh.example.com,old.example.com(ssl)]",
    "nginx#2 [fresh.example.com(ssl),old.example.com(ssl)]",
    "nginx#3 [fresh.example.com(ssl)]",
  ]);
  assert.equal(listProjectDomains(h.projectId)[0].useSsl, true);
});

test("if the certificate cannot be issued, the new hostname is taken away and the old one is untouched", async () => {
  const h = harness({ cert: false });
  setProjectDomainSsl(h.projectId, h.oldId, true);
  const result = await renameProjectHostname(h.projectId, h.oldId, { managedDomainId: listManagedDomains()[0].id, label: "fresh" }, h.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /rate limited/);
  assert.deepEqual(listProjectDomains(h.projectId).map((d) => [d.domain, d.useSsl]), [["old.example.com", true]]);
  assert.equal(h.log.at(-1), "nginx#2 [old.example.com(ssl)]", "nginx was re-applied without the new name");
});

test("if nginx refuses the new hostname, nothing changes for the old one", async () => {
  const h = harness({ nginx: (n) => n !== 1 });
  const result = await renameProjectHostname(h.projectId, h.oldId, { managedDomainId: listManagedDomains()[0].id, label: "fresh" }, h.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /nginx refused/);
  assert.deepEqual(listProjectDomains(h.projectId).map((d) => d.domain), ["old.example.com"]);
});

test("a rename to a taken, invalid or identical hostname is refused before anything is added", async () => {
  const h = harness();
  const baseId = listManagedDomains()[0].id;
  addManagedProjectDomain(project("someone-else"), baseId, "taken");
  for (const [label, expected] of [["taken", /already used/], ["a.b", /Dots/], ["old", /already this hostname|already used/]] as const) {
    const result = await renameProjectHostname(h.projectId, h.oldId, { managedDomainId: baseId, label }, h.deps);
    assert.equal(result.ok, false, label);
    assert.match(result.reason ?? "", expected, label);
  }
  assert.deepEqual(h.log, [], "nginx was never touched");
  assert.deepEqual(listProjectDomains(h.projectId).map((d) => d.domain), ["old.example.com"]);
  assert.equal((await renameProjectHostname(h.projectId, 999999, { managedDomainId: baseId, label: "x" }, h.deps)).ok, false);
});

test("an unrouted hostname can be renamed too: the new one is unrouted as well", async () => {
  reset();
  const baseDomain = addManagedDomain("example.com");
  const id = project("unrouted-rename");
  const old = reserveHostnameForProject(id, "unrouted-rename")!;
  const deps: RenameDeps = { applyNginx: async () => ({ ok: true, message: "" }), issueCertificate: async () => ({ ok: true, message: "" }) };
  const result = await renameProjectHostname(id, old.id, { managedDomainId: baseDomain.id, label: "better" }, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(listProjectDomains(id).map((d) => [d.domain, d.service]), [["better.example.com", ""]]);
  assert.equal(getProjectDomain(id, old.id), null);
  assert.ok(setProjectDomainRoute(id, result.hostname!.id, "web", 80));
});

test("the rename endpoint needs a login, and refuses an unknown hostname", async () => {
  const h = harness();
  assert.equal((await fetch(`${base}/api/projects/${h.projectId}/domains/${h.oldId}/rename`, { method: "POST" })).status, 401);
  assert.equal((await call("POST", `/projects/${h.projectId}/domains/999999/rename`, { managedDomainId: 1, label: "x" })).status, 404);
  assert.equal((await call("POST", `/projects/999999/domains/${h.oldId}/rename`, { managedDomainId: 1, label: "x" })).status, 404);
});
