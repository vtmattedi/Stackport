import { before, test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDatabase, initializeDatabase } from "../src/config/database";
import type { ApiToken } from "../src/modules/identity/apiTokens";
import { createProject } from "../src/modules/projects/operations";
import { addProjectDomain, listProjectDomains } from "../src/modules/ingress/domains";
import { addManagedDomain, addManagedProjectDomain } from "../src/modules/ingress/managedDomains";
import { ConfirmationStore, defaultHostnameDeps, registerWriteTools, type HostnameDeps, type HostnamePlan, type ProjectLike, type WriteDeps } from "../src/transports/mcp/writeTools";
import { listManagedDomainsView } from "../src/transports/mcp/readModel";

before(() => { initializeDatabase(); });

const token = (overrides: Partial<ApiToken> = {}): ApiToken => ({
  id: 9, name: "ci", prefix: "spk_abc", scopes: ["read", "write"], projectGroup: null, createdAt: "", lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides,
});

function reset(): void {
  getDatabase().prepare("DELETE FROM project_domains").run();
  getDatabase().prepare("DELETE FROM managed_domains").run();
}

const projectLike = (id: number, name: string, groupName: string | null = null): ProjectLike => ({ id, name, groupName, lastStatus: "up", autoDeployBranch: null });

/** The write tools with the real hostname validation and a fake runner, so nothing touches nginx or certbot. */
async function connect(options: { token?: ApiToken; projects: Record<number, ProjectLike>; busy?: boolean }) {
  const started: HostnamePlan[] = [];
  const real = defaultHostnameDeps();
  const hosts: HostnameDeps = { preview: real.preview, start: (plan) => { if (options.busy) return null; started.push(plan); return { id: `a${started.length}` }; } };
  const deps: WriteDeps = { getProject: (id) => options.projects[id] ?? null, rollbackTarget: () => ({ ok: false, error: "" }), start: () => null, now: Date.now };
  const server = new McpServer({ name: "t", version: "1" });
  registerWriteTools(server, options.token ?? token(), deps, new ConfirmationStore(), undefined, hosts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "stackport_set_project_hostname", arguments: args });
    return { isError: result.isError === true, text: (result.content as { text: string }[])[0]?.text ?? "", body: result.structuredContent as Record<string, unknown> | undefined };
  };
  return { call, started, close: () => client.close() };
}

test("the managed-domain list shows each domain, its default, how many hostnames use it and the last DNS result, and nothing else", () => {
  reset();
  const a = addManagedDomain("example.com");
  addManagedDomain("apps.example.com");
  addManagedProjectDomain(createProject({ name: "mcp-d1", sourceType: "upload" }).id, a.id, "shop");
  const view = listManagedDomainsView();
  assert.deepEqual(view.domains.map((d) => [d.name, d.isDefault, d.hostnameCount, d.dnsStatus]), [["example.com", true, 1, "unknown"], ["apps.example.com", false, 0, "unknown"]]);
  for (const d of view.domains) assert.deepEqual(Object.keys(d).sort(), ["dnsCheckedAt", "dnsStatus", "hostnameCount", "isDefault", "name"]);
});

test("a first call only describes the rename; the confirmed call runs exactly that, once", async () => {
  reset();
  const domain = addManagedDomain("example.com");
  const id = createProject({ name: "mcp-h1", sourceType: "upload" }).id;
  addManagedProjectDomain(id, domain.id, "old", "web", 80);
  const h = await connect({ projects: { [id]: projectLike(id, "mcp-h1") } });
  const preview = await h.call({ projectId: id, managedDomain: "example.com", label: "fresh" });
  assert.equal(preview.isError, false);
  assert.match(String(preview.body?.["summary"]), /Rename the hostname old\.example\.com of "mcp-h1" to fresh\.example\.com/);
  assert.match(String(preview.body?.["summary"]), /stops answering at once, with no redirect/);
  assert.deepEqual(h.started, [], "nothing ran");
  assert.deepEqual(listProjectDomains(id).map((d) => d.domain), ["old.example.com"]);

  const confirmationId = String(preview.body?.["confirmationId"]);
  const run = await h.call({ projectId: id, managedDomain: "example.com", label: "fresh", confirmationId });
  assert.equal(run.body?.["started"], true);
  assert.deepEqual(h.started.map((p) => [p.replaces?.domain, p.newHostname]), [["old.example.com", "fresh.example.com"]]);
  const again = await h.call({ projectId: id, managedDomain: "example.com", label: "fresh", confirmationId });
  assert.equal(again.isError, true, "a confirmation works once");
  assert.equal(h.started.length, 1);
  await h.close();
});

test("a confirmation is only good for the change it described", async () => {
  reset();
  addManagedDomain("example.com");
  const id = createProject({ name: "mcp-h2", sourceType: "upload" }).id;
  addProjectDomain(id, "plain.org");
  const h = await connect({ projects: { [id]: projectLike(id, "mcp-h2") } });
  const preview = await h.call({ projectId: id, managedDomain: "example.com", label: "one" });
  const confirmationId = String(preview.body?.["confirmationId"]);
  const other = await h.call({ projectId: id, managedDomain: "example.com", label: "two", confirmationId });
  assert.equal(other.isError, true);
  assert.match(other.text, /different arguments|unknown|expired/);
  assert.equal(h.started.length, 0);
  await h.close();
});

test("a token limited to a project group cannot change another group's project, not even to preview", async () => {
  reset();
  addManagedDomain("example.com");
  const id = createProject({ name: "mcp-h3", sourceType: "upload" }).id;
  const h = await connect({ token: token({ projectGroup: "staging" }), projects: { [id]: projectLike(id, "mcp-h3", "prod") } });
  const out = await h.call({ projectId: id, managedDomain: "example.com", label: "x" });
  assert.equal(out.isError, true);
  assert.match(out.text, /group "staging"/);
  assert.equal((await h.call({ projectId: 999, managedDomain: "example.com", label: "x" })).isError, true);
  await h.close();
});

test("bad requests are refused in the preview with a reason, before any confirmation exists", async () => {
  reset();
  const d = addManagedDomain("example.com");
  const id = createProject({ name: "mcp-h4", sourceType: "upload" }).id;
  addManagedProjectDomain(id, d.id, "a", "web", 80);
  addManagedProjectDomain(id, d.id, "b", "web", 80);
  const taken = createProject({ name: "mcp-h4-other", sourceType: "upload" }).id;
  addManagedProjectDomain(taken, d.id, "taken");
  const h = await connect({ projects: { [id]: projectLike(id, "mcp-h4") } });
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ managedDomain: "nope.com", label: "x" }, /not a managed domain/],
    [{ managedDomain: "example.com", label: "a.b" }, /Dots are not allowed/],
    [{ managedDomain: "example.com", label: "x" }, /several hostnames/],
    [{ managedDomain: "example.com", label: "x", hostname: "missing.example.com" }, /no hostname/],
    [{ managedDomain: "example.com", label: "taken", hostname: "a.example.com" }, /already used/],
    [{ managedDomain: "example.com", label: "b", hostname: "b.example.com" }, /already this hostname|already used/],
  ];
  for (const [args, expected] of cases) {
    const out = await h.call({ projectId: id, ...args });
    assert.equal(out.isError, true, JSON.stringify(args));
    assert.match(out.text, expected, JSON.stringify(args));
  }
  assert.equal(h.started.length, 0);
  await h.close();
});

test("the bare domain: the preview says which name is served and which redirects, and www canonical needs the bare domain free", async () => {
  reset();
  addManagedDomain("example.com");
  const id = createProject({ name: "mcp-h5", sourceType: "upload" }).id;
  const h = await connect({ projects: { [id]: projectLike(id, "mcp-h5") } });
  const apex = await h.call({ projectId: id, managedDomain: "example.com", label: "@" });
  assert.match(String(apex.body?.["summary"]), /Add the hostname example\.com/);
  assert.match(String(apex.body?.["summary"]), /www redirects to it/);
  const www = await h.call({ projectId: id, managedDomain: "example.com", label: "@", canonical: "www" });
  assert.match(String(www.body?.["summary"]), /Add the hostname www\.example\.com/);
  assert.match(String(www.body?.["summary"]), /bare domain redirects to www\.example\.com/);
  const other = createProject({ name: "mcp-h5-b", sourceType: "upload" }).id;
  addProjectDomain(other, "example.com");
  const blocked = await h.call({ projectId: id, managedDomain: "example.com", label: "@", canonical: "www" });
  assert.equal(blocked.isError, true, "another project already has the bare domain");
  await h.close();
});

test("a busy project is reported, not queued", async () => {
  reset();
  addManagedDomain("example.com");
  const id = createProject({ name: "mcp-h6", sourceType: "upload" }).id;
  const h = await connect({ projects: { [id]: projectLike(id, "mcp-h6") }, busy: true });
  const preview = await h.call({ projectId: id, managedDomain: "example.com", label: "x" });
  const out = await h.call({ projectId: id, managedDomain: "example.com", label: "x", confirmationId: String(preview.body?.["confirmationId"]) });
  assert.equal(out.isError, true);
  assert.match(out.text, /already running/);
  await h.close();
});
