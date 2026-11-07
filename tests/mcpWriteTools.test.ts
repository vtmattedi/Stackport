import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiToken } from "../src/modules/identity/apiTokens";
import {
  CONFIRMATION_TTL_MS, ConfirmationStore, mayActOn, registerWriteTools, type ProjectLike, type WriteDeps, type WriteKind, type WriteParams,
} from "../src/transports/mcp/writeTools";

const PROJECTS: Record<number, ProjectLike> = {
  1: { id: 1, name: "shop", groupName: "prod", lastStatus: "up", autoDeployBranch: "main" },
  2: { id: 2, name: "blog", groupName: "staging", lastStatus: "down", autoDeployBranch: null },
  3: { id: 3, name: "loose", groupName: null, lastStatus: "up", autoDeployBranch: null },
};

const token = (overrides: Partial<ApiToken> = {}): ApiToken => ({
  id: 7, name: "ci", prefix: "spk_abc", scopes: ["read", "write"], projectGroup: null, createdAt: "", lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides,
});

interface Started { kind: WriteKind; projectId: number; params: WriteParams; actor: string }

async function connect(options: { token?: ApiToken; busy?: boolean; now?: () => number } = {}) {
  const started: Started[] = [];
  const deps: WriteDeps = {
    getProject: (id) => PROJECTS[id] ?? null,
    rollbackTarget: (projectId, deploymentId) => (projectId === 3 ? { ok: false, error: "No earlier successful deployment to roll back to." } : { ok: true, id: deploymentId ?? 41, commitSha: "abcdef1234567" }),
    start: (kind, project, params, actor) => { if (options.busy) return null; started.push({ kind, projectId: project.id, params, actor }); return { id: `action-${started.length}` }; },
    now: Date.now,
  };
  const store = new ConfirmationStore(options.now);
  const server = new McpServer({ name: "test", version: "1" });
  registerWriteTools(server, options.token ?? token(), deps, store);
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["stackport_deploy_project", "stackport_restart_project", "stackport_rollback_project", "stackport_stop_project"]);
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
