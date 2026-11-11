import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiToken } from "../src/modules/identity/apiTokens";
import {
  CONFIRMATION_TTL_MS, ConfirmationStore, mayActOn, networkGroupScopeProblem, registerWriteTools, type NetworkDeps, type ProjectLike, type WriteDeps, type WriteKind, type WriteParams,
} from "../src/transports/mcp/writeTools";
import { NetworkGroupError } from "../src/modules/deployments/networkGroupAssignment";

const PROJECTS: Record<number, ProjectLike> = {
  1: { id: 1, name: "shop", groupName: "prod", lastStatus: "up", autoDeployBranch: "main" },
  2: { id: 2, name: "blog", groupName: "staging", lastStatus: "down", autoDeployBranch: null },
  3: { id: 3, name: "loose", groupName: null, lastStatus: "up", autoDeployBranch: null },
};

const token = (overrides: Partial<ApiToken> = {}): ApiToken => ({
  id: 7, name: "ci", prefix: "spk_abc", scopes: ["read", "write"], projectGroup: null, createdAt: "", lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides,
});

interface Started { kind: WriteKind; projectId: number; params: WriteParams; actor: string }

async function connect(options: { token?: ApiToken; busy?: boolean; now?: () => number; net?: NetworkDeps; restartBlocker?: string | null } = {}) {
  const started: Started[] = [];
  const deps: WriteDeps = {
    getProject: (id) => PROJECTS[id] ?? null,
    restartBlocker: async () => options.restartBlocker ?? null,
    rollbackTarget: (projectId, deploymentId) => (projectId === 3 ? { ok: false, error: "No earlier successful deployment to roll back to." } : { ok: true, id: deploymentId ?? 41, commitSha: "abcdef1234567" }),
    start: (kind, project, params, actor) => { if (options.busy) return null; started.push({ kind, projectId: project.id, params, actor }); return { id: `action-${started.length}` }; },
    now: Date.now,
  };
  const store = new ConfirmationStore(options.now);
  const server = new McpServer({ name: "test", version: "1" });
  registerWriteTools(server, options.token ?? token(), deps, store, options.net);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    const body = result.structuredContent as Record<string, unknown> | undefined;
    return { isError: result.isError === true, text: content[0]?.text ?? "", body };
  };
  return { call, started, store, close: () => client.close() };
}

test("the four write tools are registered, marked destructive", async () => {
  const h = await connect();
  const tools = (await (async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "t", version: "1" });
    registerWriteTools(server, token(), { getProject: () => null, rollbackTarget: () => ({ ok: false, error: "" }), start: () => null, now: Date.now }, new ConfirmationStore());
    const client = new Client({ name: "c", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return (await client.listTools()).tools;
  })());
  assert.deepEqual(tools.map((t) => t.name).sort(), ["stackport_deploy_project", "stackport_restart_project", "stackport_rollback_project", "stackport_set_network_group", "stackport_set_project_hostname", "stackport_stop_project"]);
  assert.ok(tools.every((t) => t.annotations?.destructiveHint === true));
  await h.close();
});

test("a first call only describes what would happen; nothing starts", async () => {
  const h = await connect();
  const out = await h.call("stackport_stop_project", { projectId: 1 });
  assert.equal(out.isError, false);
  assert.equal(out.body?.["requiresConfirmation"], true);
  assert.match(String(out.body?.["summary"]), /Stop "shop"/);
  assert.match(String(out.body?.["confirmationId"]), /^[0-9a-f-]{36}$/);
  assert.deepEqual(h.started, []);
  await h.close();
});

test("the confirmation id from the preview runs it, once", async () => {
  const h = await connect();
  const preview = await h.call("stackport_deploy_project", { projectId: 1, branch: "release" });
  const id = String(preview.body?.["confirmationId"]);
  const run = await h.call("stackport_deploy_project", { projectId: 1, branch: "release", confirmationId: id });
  assert.equal(run.body?.["started"], true);
  assert.deepEqual(h.started, [{ kind: "deploy", projectId: 1, params: { branch: "release" }, actor: "token:ci#7" }]);
  const again = await h.call("stackport_deploy_project", { projectId: 1, branch: "release", confirmationId: id });
  assert.equal(again.isError, true, "single use");
  assert.equal(h.started.length, 1);
  await h.close();
});

test("a confirmation does not carry over to other arguments, projects or tools", async () => {
  const h = await connect();
  const id = String((await h.call("stackport_deploy_project", { projectId: 1, branch: "main" })).body?.["confirmationId"]);
  assert.equal((await h.call("stackport_deploy_project", { projectId: 1, branch: "other", confirmationId: id })).isError, true);
  const id2 = String((await h.call("stackport_deploy_project", { projectId: 1 })).body?.["confirmationId"]);
  assert.equal((await h.call("stackport_deploy_project", { projectId: 2, confirmationId: id2 })).isError, true);
  const id3 = String((await h.call("stackport_deploy_project", { projectId: 1 })).body?.["confirmationId"]);
  assert.equal((await h.call("stackport_stop_project", { projectId: 1, confirmationId: id3 })).isError, true);
  assert.deepEqual(h.started, []);
  await h.close();
});

test("a made-up confirmation id never runs anything", async () => {
  const h = await connect();
  const out = await h.call("stackport_restart_project", { projectId: 1, confirmationId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(out.isError, true);
  assert.deepEqual(h.started, []);
  await h.close();
});

test("a confirmation expires after five minutes", async () => {
  let now = 1_000_000;
  const h = await connect({ now: () => now });
  const id = String((await h.call("stackport_stop_project", { projectId: 1 })).body?.["confirmationId"]);
  now += CONFIRMATION_TTL_MS + 1;
  assert.equal((await h.call("stackport_stop_project", { projectId: 1, confirmationId: id })).isError, true);
  assert.deepEqual(h.started, []);
  await h.close();
});

test("a confirmation issued to one token is useless to another", () => {
  const store = new ConfirmationStore();
  const { id } = store.issue(7, "stop", 1, {});
  assert.equal(store.consume(id, 8, "stop", 1, {}), null);
  assert.equal(store.consume(id, 7, "stop", 1, {}), null, "and the failed attempt used it up");
});

test("a token limited to a group cannot act outside it, not even to preview", async () => {
  const h = await connect({ token: token({ projectGroup: "staging" }) });
  const outside = await h.call("stackport_stop_project", { projectId: 1 });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /group "staging"/);
  assert.equal((await h.call("stackport_stop_project", { projectId: 3 })).isError, true, "a project with no group is outside every group");
  assert.equal((await h.call("stackport_stop_project", { projectId: 2 })).isError, false);
  await h.close();
});

test("mayActOn: no group means every project", () => {
  assert.equal(mayActOn({ projectGroup: null }, { groupName: "prod" }), true);
  assert.equal(mayActOn({ projectGroup: null }, { groupName: null }), true);
  assert.equal(mayActOn({ projectGroup: "prod" }, { groupName: "prod" }), true);
  assert.equal(mayActOn({ projectGroup: "prod" }, { groupName: "staging" }), false);
});

test("an unknown project and a busy project give clear errors", async () => {
  const h = await connect();
  assert.match((await h.call("stackport_stop_project", { projectId: 99 })).text, /No project with id 99/);
  await h.close();
  const busy = await connect({ busy: true });
  const id = String((await busy.call("stackport_stop_project", { projectId: 1 })).body?.["confirmationId"]);
  const out = await busy.call("stackport_stop_project", { projectId: 1, confirmationId: id });
  assert.equal(out.isError, true);
  assert.match(out.text, /already running/);
  await busy.close();
});

test("a rollback runs the revision the preview showed", async () => {
  const h = await connect();
  const preview = await h.call("stackport_rollback_project", { projectId: 1 });
  assert.match(String(preview.body?.["summary"]), /commit abcdef1/);
  await h.call("stackport_rollback_project", { projectId: 1, confirmationId: String(preview.body?.["confirmationId"]) });
  assert.deepEqual(h.started[0].params, { deploymentId: 41 });
  await h.close();
});

test("a rollback with nothing to go back to fails before a confirmation is issued", async () => {
  const h = await connect();
  const out = await h.call("stackport_rollback_project", { projectId: 3 });
  assert.equal(out.isError, true);
  assert.match(out.text, /No earlier successful deployment/);
  await h.close();
});

test("a branch name that is not valid is refused in the preview", async () => {
  const h = await connect();
  const out = await h.call("stackport_deploy_project", { projectId: 1, branch: "bad branch; rm -rf /" });
  assert.equal(out.isError, true);
  assert.match(out.text, /Invalid branch/);
  await h.close();
});

/** A NetworkDeps over a small in-memory set of network groups. */
function fakeNet(initial: Record<number, { group: string; services: string[] }> = {}) {
  const groups: Record<number, { group: string; services: string[] }> = { ...initial };
  const visual: Record<number, string | null> = { 1: "prod", 2: "staging", 3: null };
  const names: Record<number, string> = { 1: "shop", 2: "blog", 3: "loose" };
  const applied: { projectId: number; group: string | null; services: string[] }[] = [];
  const net: NetworkDeps = {
    preview: async (projectId, group, services) => {
      const g = typeof group === "string" ? group.trim().toLowerCase() : "";
      if (g.includes(" ")) throw new NetworkGroupError(400, "group must be 1-40 characters");
      const list = (Array.isArray(services) ? services : []) as string[];
      if (g && list.includes("ghost")) throw new NetworkGroupError(400, "Not services of this project's Compose file: ghost");
      const peers = g ? Object.entries(groups).filter(([id, v]) => v.group === g && Number(id) !== projectId).map(([id]) => ({ name: names[Number(id)], visualGroup: visual[Number(id)] })) : [];
      return { group: g || null, services: g ? [...new Set(list)].sort() : [], currentGroup: groups[projectId]?.group ?? null, peers };
    },
    apply: async (projectId, group, services) => { applied.push({ projectId, group, services }); return { applied: true }; },
  };
  return { net, applied, groups };
}

test("network group: the first call only describes it; the confirmed call applies exactly what was described", async () => {
  const f = fakeNet({ 3: { group: "team", services: ["cache"] } });
  const h = await connect({ net: f.net });
  const preview = await h.call("stackport_set_network_group", { projectId: 1, group: "Team", services: ["db", "api", "db"] });
  assert.equal(preview.isError, false);
  assert.equal(preview.body?.["requiresConfirmation"], true);
  assert.match(String(preview.body?.["summary"]), /network group "team".*db \(as db\.p1\)/s);
  assert.match(String(preview.body?.["summary"]), /loose/, "names the projects that gain a path");
  assert.deepEqual(f.applied, []);
  const id = String(preview.body?.["confirmationId"]);
  const done = await h.call("stackport_set_network_group", { projectId: 1, group: "Team", services: ["db", "api"], confirmationId: id });
  assert.equal(done.body?.["done"], true);
  assert.deepEqual(f.applied, [{ projectId: 1, group: "team", services: ["api", "db"] }]);
  assert.deepEqual((done.body?.["services"] as { hostname: string }[]).map((s) => s.hostname), ["api.p1", "db.p1"]);
  assert.equal((await h.call("stackport_set_network_group", { projectId: 1, group: "team", services: ["api", "db"], confirmationId: id })).isError, true, "single use");
  await h.close();
});

test("network group: a confirmation is only good for the group and services it described", async () => {
  const f = fakeNet();
  const h = await connect({ net: f.net });
  const id = String((await h.call("stackport_set_network_group", { projectId: 1, group: "team", services: ["db"] })).body?.["confirmationId"]);
  assert.equal((await h.call("stackport_set_network_group", { projectId: 1, group: "team", services: ["db", "api"], confirmationId: id })).isError, true);
  const id2 = String((await h.call("stackport_set_network_group", { projectId: 1, group: "team", services: ["db"] })).body?.["confirmationId"]);
  assert.equal((await h.call("stackport_set_network_group", { projectId: 1, group: "other", services: ["db"], confirmationId: id2 })).isError, true);
  const id3 = String((await h.call("stackport_set_network_group", { projectId: 1, group: "team", services: ["db"] })).body?.["confirmationId"]);
  assert.equal((await h.call("stackport_stop_project", { projectId: 1, confirmationId: id3 })).isError, true, "nor for another tool");
  assert.deepEqual(f.applied, []);
  await h.close();
});

test("network group: leaving the group is described as such and clears the services", async () => {
  const f = fakeNet({ 1: { group: "team", services: ["db"] } });
  const h = await connect({ net: f.net });
  const preview = await h.call("stackport_set_network_group", { projectId: 1, group: "", services: ["db"] });
  assert.match(String(preview.body?.["summary"]), /Take "shop" out of its network group "team"/);
  await h.call("stackport_set_network_group", { projectId: 1, group: "", services: ["db"], confirmationId: String(preview.body?.["confirmationId"]) });
  assert.deepEqual(f.applied, [{ projectId: 1, group: null, services: [] }]);
  await h.close();
});

test("network group: bad names and unknown services are refused before any confirmation exists", async () => {
  const f = fakeNet();
  const h = await connect({ net: f.net });
  assert.equal((await h.call("stackport_set_network_group", { projectId: 1, group: "has space" })).isError, true);
  const ghost = await h.call("stackport_set_network_group", { projectId: 1, group: "team", services: ["ghost"] });
  assert.equal(ghost.isError, true);
  assert.match(ghost.text, /Not services/);
  assert.equal((await h.call("stackport_set_network_group", { projectId: 99, group: "team" })).isError, true);
  assert.deepEqual(f.applied, []);
  await h.close();
});

test("network group: a token limited to a project group cannot join a network group that has projects outside it", async () => {
  const f = fakeNet({ 1: { group: "prod-net", services: ["db"] } });
  const h = await connect({ net: f.net, token: token({ projectGroup: "staging" }) });
  const blocked = await h.call("stackport_set_network_group", { projectId: 2, group: "prod-net", services: ["web"] });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /outside it \(shop\)/);
  assert.equal((await h.call("stackport_set_network_group", { projectId: 2, group: "staging-net", services: ["web"] })).isError, false, "a group with no outside members is fine");
  assert.equal((await h.call("stackport_set_network_group", { projectId: 1, group: "x" })).isError, true, "and the project itself must be in scope");
  assert.deepEqual(f.applied, []);
  await h.close();
});

test("network group: the scope check is repeated on the confirmed call", async () => {
  const f = fakeNet();
  const h = await connect({ net: f.net, token: token({ projectGroup: "staging" }) });
  const id = String((await h.call("stackport_set_network_group", { projectId: 2, group: "lab", services: ["web"] })).body?.["confirmationId"]);
  // Between the preview and the confirmation a production project joins that network group.
  f.groups[1] = { group: "lab", services: ["db"] };
  const result = await h.call("stackport_set_network_group", { projectId: 2, group: "lab", services: ["web"], confirmationId: id });
  assert.equal(result.isError, true);
  assert.match(result.text, /outside it/);
  assert.deepEqual(f.applied, []);
  await h.close();
});

test("networkGroupScopeProblem: leaving is always allowed, and an unlimited token may join any group", () => {
  const prod = [{ name: "shop", visualGroup: "prod" }];
  assert.notEqual(networkGroupScopeProblem({ projectGroup: "staging" }, "lab", prod), null);
  assert.equal(networkGroupScopeProblem({ projectGroup: "staging" }, null, prod), null);
  assert.equal(networkGroupScopeProblem({ projectGroup: null }, "lab", prod), null);
  assert.equal(networkGroupScopeProblem({ projectGroup: "staging" }, "lab", [{ name: "blog", visualGroup: "staging" }]), null);
});

test("every write tool says it is destructive, in its description and in its annotation, before it is used", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "t", version: "1" });
  registerWriteTools(server, token(), { getProject: () => null, rollbackTarget: () => ({ ok: false, error: "" }), start: () => null, now: Date.now }, new ConfirmationStore());
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  for (const tool of tools) {
    assert.match(tool.description ?? "", /^DESTRUCTIVE/, tool.name);
    assert.equal(tool.annotations?.destructiveHint, true, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, false, tool.name);
    assert.match(tool.title ?? "", /\(destructive\)$/, tool.name);
  }
  const descriptions = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
  assert.match(descriptions["stackport_stop_project"], /domains stop working/);
  assert.match(descriptions["stackport_restart_project"], /no pull, no build/);
  assert.match(descriptions["stackport_set_network_group"], /security-sensitive/);
  await client.close();
});

test("restart: refused in the preview when the checkout has moved on, with no confirmation issued", async () => {
  const h = await connect({ restartBlocker: "The checkout is at 1234567 but the running revision is abcdef1." });
  const out = await h.call("stackport_restart_project", { projectId: 1 });
  assert.equal(out.isError, true);
  assert.match(out.text, /running revision is abcdef1/);
  assert.equal(out.body?.["confirmationId"], undefined);
  assert.deepEqual(h.started, []);
  await h.close();
});

test("restart: when nothing blocks it, the preview says no pull and no build", async () => {
  const h = await connect();
  const out = await h.call("stackport_restart_project", { projectId: 1 });
  assert.equal(out.isError, false);
  assert.match(String(out.body?.["summary"]), /no pull, no build/);
  await h.close();
});
