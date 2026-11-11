import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { createProject } from "../src/modules/projects/operations";
import { rowToProject } from "../src/modules/projects/types";
import { addProjectDomain, listProjectDomains, ProjectDomainError } from "../src/modules/ingress/domains";
import {
  addManagedDomain, addManagedProjectDomain, adoptHostnames, getDefaultManagedDomain, getManagedDomain, hostnameFor, listManagedDomains, removeManagedDomain,
  reserveLabel, setDefaultManagedDomain, slugify, validateLabel,
} from "../src/modules/ingress/managedDomains";
import { certificateAlias } from "../src/modules/ingress/certificates/operations";
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
  const db = getDatabase();
  db.prepare("DELETE FROM project_domains").run();
  db.prepare("DELETE FROM managed_domains").run();
}
const project = (name: string): number => createProject({ name, sourceType: "upload" }).id;
const statusOf = (fn: () => unknown): number | null => { try { fn(); return null; } catch (err) { return err instanceof ProjectDomainError ? err.statusCode : -1; } };

// ---- labels

test("a label is one DNS label; @ means the bare domain; www is allowed", () => {
  for (const good of ["app", "a", "my-app", "a1", "x".repeat(63), "www", "@", "  App  "]) assert.doesNotThrow(() => validateLabel(good, "example.com"), good);
  for (const bad of ["", "-a", "a-", "a.b", "a_b", "x".repeat(64), "a b", "é", "*", 5, null, undefined]) assert.throws(() => validateLabel(bad, "example.com"), ProjectDomainError, String(bad));
  assert.equal(validateLabel("  App  ", "example.com"), "app");
  assert.equal(hostnameFor("@", "example.com"), "example.com");
  assert.equal(hostnameFor("shop", "example.com"), "shop.example.com");
});

test("a label cannot become Stackport's own address", () => {
  getDatabase().prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('nginx_app_enabled', '1')").run();
  getDatabase().prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('nginx_app_domain', 'sp.example.com')").run();
  assert.equal(statusOf(() => validateLabel("sp", "example.com")), 409);
  assert.doesNotThrow(() => validateLabel("other", "example.com"));
  reset();
  assert.equal(statusOf(() => addManagedDomain("sp.example.com")), 409, "its own address cannot be a base domain");
  getDatabase().prepare("DELETE FROM app_meta WHERE key IN ('nginx_app_enabled', 'nginx_app_domain')").run();
});

test("slugs: lower case, ASCII, hyphens, at most 63 characters, never empty", () => {
  assert.equal(slugify("My Shop!"), "my-shop");
  assert.equal(slugify("Café  Ünï"), "cafe-uni");
  assert.equal(slugify("---"), "project");
  assert.equal(slugify("a".repeat(100)).length, 63);
  assert.ok(!slugify(`${"a".repeat(62)}-b`).endsWith("-"));
});

// ---- base domains

test("the first base domain is the default, there is only ever one, and the default can be moved", () => {
  reset();
  const first = addManagedDomain("Example.COM");
  assert.deepEqual([first.name, first.isDefault], ["example.com", true]);
  const second = addManagedDomain("apps.example.com");
  assert.equal(second.isDefault, false);
  assert.equal(getDefaultManagedDomain()?.name, "example.com");
  setDefaultManagedDomain(second.id);
  assert.deepEqual(listManagedDomains().filter((d) => d.isDefault).map((d) => d.name), ["apps.example.com"]);
  const third = addManagedDomain("third.example.com", true);
  assert.equal(third.isDefault, true);
  assert.equal(listManagedDomains().filter((d) => d.isDefault).length, 1);
  assert.equal(setDefaultManagedDomain(999999), null);
});

test("a base domain must be a real name, and cannot be added twice", () => {
  reset();
  for (const bad of ["", "localhost", "-x.com", "a b.com", "x..com", 5, null]) assert.equal(statusOf(() => addManagedDomain(bad)), 400, String(bad));
  addManagedDomain("example.com");
  assert.equal(statusOf(() => addManagedDomain("EXAMPLE.com")), 409);
});

test("a base domain that hostnames use cannot be removed; an unused one can", () => {
  reset();
  const d = addManagedDomain("example.com");
  const unused = addManagedDomain("unused.example.org");
  addManagedProjectDomain(project("rm-a"), d.id, "shop");
  assert.equal(statusOf(() => removeManagedDomain(d.id)), 409);
  assert.equal(getManagedDomain(d.id)?.hostnameCount, 1);
  assert.equal(removeManagedDomain(unused.id), true);
  assert.equal(removeManagedDomain(unused.id), false);
});

// ---- reserving a hostname for a project

test("a taken label gets -2, -3, and www is never handed out automatically", () => {
  reset();
  const d = addManagedDomain("example.com");
  assert.equal(reserveLabel(d, "My Shop"), "my-shop");
  addManagedProjectDomain(project("res-a"), d.id, "my-shop");
  assert.equal(reserveLabel(d, "My Shop"), "my-shop-2");
  addManagedProjectDomain(project("res-b"), d.id, "my-shop-2");
  assert.equal(reserveLabel(d, "my shop"), "my-shop-3");
  assert.equal(reserveLabel(d, "www"), "www-2", "a project called www does not take www.example.com");
  const long = "x".repeat(63);
  addManagedProjectDomain(project("res-c"), d.id, long);
  assert.equal(reserveLabel(d, long).length <= 63, true);
});

// ---- adoption

test("existing hostnames are adopted: one label, the bare domain and www, by the longest base domain; the rest stay unmanaged", () => {
  reset();
  const p = project("adopt");
  for (const host of ["shop.example.com", "example.com", "www.example.com", "a.b.example.com", "x.apps.example.com", "other.org", "ex.example.com.evil.net"]) addProjectDomain(p, host);
  addManagedDomain("example.com");
  addManagedDomain("apps.example.com");
  const byHost = Object.fromEntries(listProjectDomains(p).map((d) => [d.domain, [d.managedDomainId === null ? null : getManagedDomain(d.managedDomainId)?.name, d.label]]));
  assert.deepEqual(byHost["shop.example.com"], ["example.com", "shop"]);
  assert.deepEqual(byHost["example.com"], ["example.com", "@"]);
  assert.deepEqual(byHost["www.example.com"], ["example.com", "www"]);
  assert.deepEqual(byHost["x.apps.example.com"], ["apps.example.com", "x"], "the longest matching base domain wins");
  assert.deepEqual(byHost["a.b.example.com"], [null, null], "two labels in front: left alone");
  assert.deepEqual(byHost["other.org"], [null, null]);
  assert.deepEqual(byHost["ex.example.com.evil.net"], [null, null]);
  assert.deepEqual(listProjectDomains(p).map((d) => d.domain).sort(), ["a.b.example.com", "example.com", "ex.example.com.evil.net", "other.org", "shop.example.com", "www.example.com", "x.apps.example.com"].sort(), "no hostname was changed");
  assert.equal(adoptHostnames(), 0, "and it is idempotent");
});

// ---- the bare domain and www

test("the bare domain with the apex canonical is one hostname; www redirects to it (nginx does that for any bare domain)", () => {
  reset();
  const d = addManagedDomain("example.com");
  const created = addManagedProjectDomain(project("apex-a"), d.id, "@", "web", 3000);
  assert.deepEqual([created.domain, created.label, created.redirectApex], ["example.com", "@", false]);
});

test("the bare domain with www canonical is www.example.com, and the bare domain is spoken for", () => {
  reset();
  const d = addManagedDomain("example.com");
  const created = addManagedProjectDomain(project("www-a"), d.id, "@", "web", 3000, "www");
  assert.deepEqual([created.domain, created.label, created.redirectApex], ["www.example.com", "www", true]);
  assert.equal(statusOf(() => addProjectDomain(project("www-b"), "example.com")), 409, "the bare domain now redirects to the first project's site");
  assert.equal(statusOf(() => addManagedProjectDomain(project("www-c"), d.id, "@", "web", 3000)), 409);
  assert.doesNotThrow(() => addManagedProjectDomain(project("www-d"), d.id, "shop"), "other labels are unaffected");
});

test("the bare domain cannot be claimed as canonical-www when another project already has it", () => {
  reset();
  const d = addManagedDomain("example.com");
  addManagedProjectDomain(project("bare-a"), d.id, "@", "web", 3000);
  assert.equal(statusOf(() => addManagedProjectDomain(project("bare-b"), d.id, "@", "web", 3000, "www")), 409);
});

test("www chosen as a plain label is a hostname of its own with no redirect", () => {
  reset();
  const d = addManagedDomain("example.com");
  const created = addManagedProjectDomain(project("plain-www"), d.id, "www");
  assert.deepEqual([created.domain, created.label, created.redirectApex], ["www.example.com", "www", false]);
});

test("the certificate covers both names: www for a bare domain, the bare domain for a canonical www", () => {
  reset();
  const d = addManagedDomain("example.com");
  addManagedProjectDomain(project("cert-apex"), d.id, "@", "web", 3000);
  assert.equal(certificateAlias("example.com", "domain"), "www.example.com");
  reset();
  const d2 = addManagedDomain("example.com");
  addManagedProjectDomain(project("cert-www"), d2.id, "@", "web", 3000, "www");
  assert.equal(certificateAlias("www.example.com", "domain"), "example.com");
  assert.equal(certificateAlias("shop.example.com", "subdomain"), null);
});

test("nginx: canonical apex has www redirecting to it; canonical www has the bare domain redirecting to www, and neither name is served twice", async () => {
  const { generateNginxConfig } = await import("../src/modules/ingress/nginx/configWriter");
  const render = async (): Promise<string> => generateNginxConfig((getDatabase().prepare("SELECT * FROM projects ORDER BY id").all() as Parameters<typeof rowToProject>[0][]).map(rowToProject));
  const serverNames = (config: string): string[] => [...config.matchAll(/server_name ([^;]+);/g)].map((m) => m[1].trim());

  reset();
  const apex = addManagedDomain("example.com");
  addManagedProjectDomain(project("nginx-apex"), apex.id, "@", "web", 3000);
  let config = await render();
  assert.ok(serverNames(config).includes("www.example.com"));
  assert.match(config, /server_name www\.example\.com;[\s\S]*?return 301 http:\/\/example\.com\$request_uri;/);
  assert.equal(serverNames(config).filter((n) => n === "example.com").length >= 1, true);

  reset();
  const www = addManagedDomain("example.com");
  addManagedProjectDomain(project("nginx-www"), www.id, "@", "web", 3000, "www");
  config = await render();
  assert.match(config, /server_name example\.com;[\s\S]*?return 301 http:\/\/www\.example\.com\$request_uri;/, "the bare domain redirects to www");
  assert.ok(!/server_name www\.example\.com;[\s\S]{0,200}return 301/.test(config), "www itself is served, not redirected");
  assert.match(config, /http:\/\/sp\d+-web:3000/, "and it proxies to the service");
  const names = serverNames(config).filter((n) => n === "example.com" || n === "www.example.com");
  assert.deepEqual([...names].sort(), ["example.com", "www.example.com"], "each name appears in exactly one server block (http)");
});

// ---- over HTTP

const call = (method: string, path: string, body?: unknown, auth = true): Promise<Response> =>
  fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

test("the base domain API needs a login, and validates", async () => {
  reset();
  assert.equal((await call("GET", "/domains", undefined, false)).status, 401);
  assert.equal((await call("POST", "/domains", { name: "example.com" }, false)).status, 401);
  assert.equal((await call("POST", "/domains", { name: "nope" })).status, 400);
  const added = await call("POST", "/domains", { name: "example.com" });
  assert.equal(added.status, 201);
  const id = ((await added.json()) as { domain: { id: number } }).domain.id;
  assert.equal((await call("POST", "/domains", { name: "example.com" })).status, 409);
  assert.equal((await call("PATCH", `/domains/${id}`, { isDefault: false })).status, 400);
  assert.equal((await call("PATCH", "/domains/999999", { isDefault: true })).status, 404);
  assert.equal((await call("DELETE", `/domains/${id}`)).status, 200);
  assert.equal((await call("DELETE", `/domains/${id}`)).status, 404);
});

test("the hostname overview shows every hostname with its project, route and which other name redirects to it", async () => {
  reset();
  const apex = addManagedDomain("example.com");
  const a = project("overview-a");
  const b = project("overview-b");
  addManagedProjectDomain(a, apex.id, "@", "web", 3000);
  addManagedProjectDomain(b, apex.id, "shop", "api", 8080);
  addProjectDomain(b, "other.org");
  const res = await call("GET", "/domains/hostnames");
  assert.equal(res.status, 200);
  const { hostnames } = (await res.json()) as { hostnames: { domain: string; projectName: string; baseDomain: string | null; alsoAnswers: string | null; service: string; containerPort: number | null; certificate: unknown }[] };
  const by = Object.fromEntries(hostnames.map((h) => [h.domain, h]));
  assert.deepEqual([by["example.com"].projectName, by["example.com"].baseDomain, by["example.com"].alsoAnswers], ["overview-a", "example.com", "www.example.com"]);
  assert.deepEqual([by["shop.example.com"].alsoAnswers, by["shop.example.com"].service, by["shop.example.com"].containerPort], [null, "api", 8080]);
  assert.deepEqual([by["other.org"].baseDomain, by["other.org"].alsoAnswers], [null, null]);

  reset();
  const www = addManagedDomain("example.com");
  addManagedProjectDomain(project("overview-c"), www.id, "@", "web", 3000, "www");
  const canonical = ((await (await call("GET", "/domains/hostnames")).json()) as { hostnames: { domain: string; alsoAnswers: string | null }[] }).hostnames;
  assert.deepEqual(canonical.map((h) => [h.domain, h.alsoAnswers]), [["www.example.com", "example.com"]]);
  assert.equal((await call("GET", "/domains/hostnames", undefined, false)).status, 401);
});

test("over HTTP a hostname's base domain and label are checked before its route, so the error is the right one", async () => {
  reset();
  const domain = ((await (await call("POST", "/domains", { name: "example.com" })).json()) as { domain: { id: number } }).domain;
  const { id: projectId } = createProject({ name: "http-host", sourceType: "upload" });
  const label = async (body: Record<string, unknown>): Promise<{ status: number; error: string }> => {
    const res = await call("POST", `/projects/${projectId}/domains`, body);
    return { status: res.status, error: ((await res.json()) as { error: string }).error };
  };
  assert.match((await label({ managedDomainId: domain.id, label: "a.b" })).error, /Dots are not allowed/);
  assert.match((await label({ managedDomainId: domain.id, label: "" })).error, /label must be/);
  assert.match((await label({ managedDomainId: 999999, label: "x" })).error, /Choose one of the managed domains/);
  assert.match((await label({ managedDomainId: domain.id, label: "@" })).error, /service/, "a valid label then reaches the route check");
});
