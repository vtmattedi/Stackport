import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { encryptSecret } from "../src/shared/crypto";
import { createProject, updateProject } from "../src/modules/projects/operations";
import { addProjectDomain } from "../src/modules/ingress/domains";
import { addManagedDomain } from "../src/modules/ingress/managedDomains";
import { createProjectEnvFile } from "../src/modules/deployments/operations";
import { actionLogPath } from "../src/modules/actions/log";
import { actionRegistry, projectRepoKey } from "../src/modules/actions/registry";
import { listProjectEnvFiles } from "../src/modules/projects/envFiles";
import { projectRepoDir } from "../src/modules/projects/workspace";
import { createApiToken, revokeApiToken } from "../src/modules/identity/apiTokens";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { safeRepo } from "../src/transports/mcp/readModel";
import app from "../src/app";

const SECRETS = ["ENV-VALUE-SECRET-1", "NGINX-SECRET-2", "CREDENTIAL-SECRET-3", "SECRET_ENV_NAME"];

let server: Server;
let base: string;
let projectId: number;
let token: string;

before(async () => {
  initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  projectId = createProject({ name: "mcp-app", sourceType: "github", githubRepo: "owner/repo", autoDeployBranch: "main" }).id;
  addProjectDomain(projectId, "mcp.example.com", true);
  updateProject(projectId, { nginxExtraConfig: `# ${SECRETS[1]}` });
  createProjectEnvFile(projectId, ".env", [{ key: SECRETS[3], value: SECRETS[0] }]);
  getDatabase().prepare("INSERT INTO credentials (type, alias, secret_enc) VALUES ('github', 'gh', ?)").run(encryptSecret(SECRETS[2]));
  const credentialId = (getDatabase().prepare("SELECT id FROM credentials WHERE alias = 'gh'").get() as { id: number }).id;
  getDatabase().prepare("UPDATE projects SET github_credential_id = ? WHERE id = ?").run(credentialId, projectId);

  token = createApiToken({ name: "test" }).token;
});

after(() => { server.close(); });

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  }));
  return client;
}

async function status(bearer: string | null): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

test("requests without a valid API token are rejected", async () => {
  assert.equal(await status(null), 401);
  assert.equal(await status("spk_not-a-real-token"), 401);
  assert.equal(await status(issueAuthToken("admin")), 401, "an admin session token is not an API token");
});

test("revoked and expired tokens are rejected", async () => {
  const revoked = createApiToken({ name: "revoked" });
  revokeApiToken(revoked.record.id);
  assert.equal(await status(revoked.token), 401);

  const expired = createApiToken({ name: "expired", expiresInDays: 1 });
  getDatabase().prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.record.id);
  assert.equal(await status(expired.token), 401);
});

test("an API token is not accepted by the admin API", async () => {
  const res = await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

test("only the read-only tools exist", async () => {
  const client = await connect(token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "stackport_get_project", "stackport_get_project_action", "stackport_get_project_ingress_health",
    "stackport_get_project_network_group", "stackport_get_project_setup", "stackport_inspect_project_repository",
    "stackport_list_docker_networks", "stackport_list_github_repositories", "stackport_list_managed_domains",
    "stackport_list_network_groups", "stackport_list_project_actions", "stackport_list_project_branches",
    "stackport_list_projects", "stackport_status",
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  await client.close();
});

test("HTTP MCP configures branches, env files and service targets without returning secret values", async () => {
  const client = await connect(createApiToken({ name: "setup", scope: "write" }).token);
  const project = createProject({ name: "workflow", sourceType: "github", githubRepo: "owner/workflow", autoDeployBranch: "main" });
  const id = project.id;
  const checkout = projectRepoDir(project);
  const composeFile = "compose.production.yaml";
  await fs.mkdir(checkout, { recursive: true });
  await fs.writeFile(path.join(checkout, composeFile), "services:\n  web:\n    image: nginx\n    expose: ['80']\n    env_file: [.env]\n");
  addManagedDomain("mcp-preview.example.com", true);

  async function call(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name: `stackport_${name}`, arguments: { projectId: id, ...args } });
  }

  async function confirm(name: string, args: Record<string, unknown>) {
    const preview = payload(await call(name, args));
    assert.equal(preview["requiresConfirmation"], true);
    const result = await call(name, { ...args, confirmationId: preview["confirmationId"] });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return payload(result);
  }

  try {
    assert.equal((await confirm("set_project_branch", { branch: "release" }))["branch"], "release");
    assert.equal((await confirm("set_project_compose_file", { composeFile }))["composeFile"], composeFile);

    const value = "literal-value-kept-out-of-responses";
    const largeValue = "value".repeat(3000);
    const env = { relativePath: ".env", variables: [{ key: "KEEP", value }, { key: "LARGE_VALUE", value: largeValue }, { key: "REMOVE", value: "remove-me" }] };
    const preview = await call("set_project_env_file", env);
    assert.ok(!JSON.stringify(preview).includes(value));
    assert.deepEqual(listProjectEnvFiles(id), []);
    const changed = { ...env, variables: [{ key: "KEEP", value: "something-else" }], confirmationId: payload(preview)["confirmationId"] };
    assert.equal((await call("set_project_env_file", changed)).isError, true);
    assert.deepEqual(await confirm("set_project_env_file", env), { ok: true });
    assert.deepEqual(await confirm("set_project_env_file", { relativePath: ".env", removeKeys: ["REMOVE"] }), { ok: true });

    const formats = {
      hex: /^[a-f0-9]{34}$/,
      b32: /^[A-Z2-7]{28}$/,
      b64: /^[A-Za-z0-9+/]{23}=$/,
      b64url: /^[A-Za-z0-9_-]{23}$/,
    };
    const tooShort = await call("generate_project_env_value", { relativePath: ".env", key: "TOO_SHORT", size: 3, format: "b64url" });
    assert.equal(tooShort.isError, true);
    for (const [format, pattern] of Object.entries(formats)) {
      const key = `GEN_${format.toUpperCase()}`;
      assert.deepEqual(await confirm("generate_project_env_value", { relativePath: ".env", key, size: 17, format }), { ok: true });
      const generated = listProjectEnvFiles(id)[0].variables.find((item) => item.key === key);
      assert.match(generated?.value ?? "", pattern);
    }
    const stored = listProjectEnvFiles(id)[0].variables;
    assert.equal(stored.find(({ key }) => key === "KEEP")?.value, value);
    assert.equal(stored.find(({ key }) => key === "LARGE_VALUE")?.value, largeValue);
    assert.ok(!stored.some(({ key }) => key === "REMOVE"));

    const previewBranch = await confirm("create_branch_deployment", { branch: "preview/new", env: "shared" });
    assert.match(String(previewBranch["url"]), /^https:\/\/.+\.mcp-preview\.example\.com\/$/);
    const childId = previewBranch["projectId"];
    assert.equal((await call("generate_project_env_value", { projectId: childId, relativePath: ".env", key: "KEEP", size: 24, format: "b32" })).isError, true);
    const setup = payload(await call("get_project_setup", { projectId: childId }));
    assert.equal((setup["env"] as { ownerProjectId: number }).ownerProjectId, id);
    for (const item of stored) assert.ok(!JSON.stringify(setup).includes(item.value));
    const parent = payload(await call("get_project_setup"));
    assert.deepEqual((parent["compose"] as { targets: unknown[] }).targets, [{ service: "web", containerPort: 80 }]);

    const bad = await call("add_project_domain", { domain: "preview.example.com", service: "web", containerPort: 81 });
    assert.equal(bad.isError, true, "only declared ports can be routed");
    const hostArgs = { domain: "preview.example.com", service: "web", containerPort: 80 };
    const hostPreview = await call("add_project_domain", hostArgs);
    assert.match(String(payload(hostPreview)["summary"]), /HTTPS/);
    let finishPull!: (result: { ok: boolean }) => void;
    const pull = new Promise<{ ok: boolean }>((resolve) => { finishPull = resolve; });
    assert.ok(actionRegistry.tryStart(projectRepoKey(id), "pull", { projectId: id }, () => pull));
    try {
      const blocked = await call("add_project_domain", { ...hostArgs, confirmationId: payload(hostPreview)["confirmationId"] });
      assert.equal(blocked.isError, true);
      assert.match(JSON.stringify(blocked.content), /already running/);
      assert.equal(getDatabase().prepare("SELECT id FROM project_domains WHERE domain = ?").get(hostArgs.domain), undefined);
    } finally {
      finishPull({ ok: true });
    }
  } finally {
    await client.close();
  }
});

test("action status and masked output respect project group and log scope", async () => {
  const project = createProject({ name: "Action history", groupName: "team-action", sourceType: "upload" });
  const actionId = "cbe8dcdb-ffdd-4f21-9a07-3582e9439a93";
  const log = actionLogPath(actionId);
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, "Step 1\nBuild failed: test-action-secret\n");
  createProjectEnvFile(project.id, ".env", [{ key: "APP_SECRET", value: "test-action-secret" }]);
  getDatabase().prepare(`
    INSERT INTO actions (id, key, kind, project_id, status, triggered_by, started_at, log_path)
    VALUES (?, ?, 'deploy', ?, 'failed', 'mcp', ?, ?)
  `).run(actionId, `project:${project.id}`, project.id, new Date().toISOString(), log);

  const reader = await connect(createApiToken({ name: "action reader" }).token);
  const allowed = await connect(createApiToken({ name: "action logs", actionLogs: true, projectGroup: "team-action" }).token);
  const denied = await connect(createApiToken({ name: "other action logs", actionLogs: true, projectGroup: "other-action" }).token);
  const statusTool = { name: "stackport_get_project_action", arguments: { actionId } };
  const logTool = { name: "stackport_get_project_action_log", arguments: { actionId } };
  try {
    assert.equal(payload(await reader.callTool(statusTool))["status"], "failed");
    assert.ok(!(await reader.listTools()).tools.some(({ name }) => name === logTool.name));
    assert.equal((await denied.callTool(statusTool)).isError, true);
    assert.equal((await denied.callTool(logTool)).isError, true);
    const result = await allowed.callTool(logTool);
    assert.match(String(payload(result)["output"]), /Build failed: \*\*\*/);
    assert.ok(!JSON.stringify(result).includes("test-action-secret"));
    getDatabase().prepare("UPDATE actions SET kind = 'backup' WHERE id = ?").run(actionId);
    assert.equal((await allowed.callTool(logTool)).isError, true);
  } finally {
    await Promise.all([reader.close(), allowed.close(), denied.close()]);
  }
});

function payload(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return res.structuredContent as Record<string, unknown>;
}

test("list_projects returns exactly the allowlisted fields", async () => {
  const client = await connect(token);
  const { projects } = payload(await client.callTool({ name: "stackport_list_projects", arguments: {} })) as { projects: Record<string, unknown>[] };
  const project = projects.find((p) => p.id === projectId)!;
  assert.deepEqual(Object.keys(project).sort(), [
    "branch", "deployTrigger", "domains", "group", "health", "id", "lastCommit", "name", "paused", "pendingDeploySha", "repo", "sourceType",
  ]);
  assert.equal(project.repo, "owner/repo");
  assert.deepEqual(project.domains, [{ hostname: "mcp.example.com", ssl: true }]);
  await client.close();
});

test("get_project returns exactly the allowlisted fields", async () => {
  const client = await connect(token);
  const project = payload(await client.callTool({ name: "stackport_get_project", arguments: { projectId } }));
  assert.deepEqual(Object.keys(project).sort(), [
    "branch", "composeFile", "containers", "deployTrigger", "deployments", "domains", "group", "health", "id",
    "lastCommit", "name", "paused", "pendingDeploySha", "repo", "runningAction", "sourceType",
  ]);
  await client.close();
});

test("ingress health returns exactly the allowlisted fields, and an unknown project is a tool error", async () => {
  const client = await connect(token);
  const health = payload(await client.callTool({ name: "stackport_get_project_ingress_health", arguments: { projectId } }));
  assert.deepEqual(Object.keys(health).sort(), ["isolated", "nginx", "projectId", "routes", "status", "summary"]);
  assert.deepEqual(Object.keys(health.nginx as object).sort(), ["onSharedNetwork", "running"]);
  assert.equal((await client.callTool({ name: "stackport_get_project_ingress_health", arguments: { projectId: 999999 } })).isError, true);
  await client.close();
});

test("network group tools return exactly the allowlisted fields", async () => {
  const other = createProject({ name: "mcp-peer", sourceType: "upload" }).id;
  getDatabase().prepare("UPDATE projects SET network_group = 'mcp-net' WHERE id IN (?, ?)").run(projectId, other);
  getDatabase().prepare("INSERT INTO network_group_services (project_id, service) VALUES (?, 'db')").run(projectId);
  const client = await connect(token);
  const list = payload(await client.callTool({ name: "stackport_list_network_groups", arguments: {} })) as { groups: { group: string; projects: Record<string, unknown>[] }[] };
  const group = list.groups.find((g) => g.group === "mcp-net")!;
  assert.deepEqual(Object.keys(group).sort(), ["group", "projects"]);
  assert.deepEqual(Object.keys(group.projects[0]).sort(), ["name", "projectId", "services"]);
  assert.deepEqual(group.projects.find((p) => p.projectId === projectId)!.services, [{ service: "db", hostname: `db.p${projectId}` }]);
  const one = payload(await client.callTool({ name: "stackport_get_project_network_group", arguments: { projectId } }));
  assert.deepEqual(Object.keys(one).sort(), ["availableServices", "group", "hostnames", "peers", "projectId", "services"]);
  assert.equal((await client.callTool({ name: "stackport_get_project_network_group", arguments: { projectId: 999999 } })).isError, true);
  await client.close();
  getDatabase().prepare("UPDATE projects SET network_group = NULL WHERE id IN (?, ?)").run(projectId, other);
  getDatabase().prepare("DELETE FROM network_group_services WHERE project_id = ?").run(projectId);
});

test("no tool output contains a stored secret, env name or nginx config", async () => {
  const client = await connect(token);
  const outputs = [
    await client.callTool({ name: "stackport_status", arguments: {} }),
    await client.callTool({ name: "stackport_list_projects", arguments: {} }),
    await client.callTool({ name: "stackport_get_project", arguments: { projectId } }),
  ].map((r) => JSON.stringify(r));
  for (const output of outputs) {
    for (const secret of SECRETS) assert.equal(output.includes(secret), false, `output contains ${secret}`);
    assert.equal(/credential|secret|_enc|nginx/i.test(output), false, "no credential, secret or nginx fields");
  }
  await client.close();
});

test("an unknown project is a tool error, not a crash", async () => {
  const client = await connect(token);
  const res = await client.callTool({ name: "stackport_get_project", arguments: { projectId: 999999 } });
  assert.equal(res.isError, true);
  await client.close();
});

test("repositories are reduced to owner/name with no credentials", () => {
  assert.equal(safeRepo("owner/repo"), "owner/repo");
  assert.equal(safeRepo("https://user:ghp_secret@github.com/owner/repo.git"), "owner/repo");
  assert.equal(safeRepo("not a repo"), null);
  assert.equal(safeRepo(null), null);
});

test("write tools are offered only to a token with the write scope", async () => {
  const names = async (bearer: string) => {
    const client = await connect(bearer);
    try { return (await client.listTools()).tools.map((t) => t.name); } finally { await client.close(); }
  };
  const readOnly = await names(token);
  assert.equal(readOnly.some((n) => /_(deploy|rollback|restart|stop)_project$/.test(n)), false);

  const writer = await names(createApiToken({ name: "writer", scope: "write" }).token);
  for (const verb of ["deploy", "rollback", "restart", "stop"]) assert.ok(writer.includes(`stackport_${verb}_project`), verb);
});

test("a write token's first call to a write tool changes nothing", async () => {
  const client = await connect(createApiToken({ name: "writer-2", scope: "write" }).token);
  try {
    const result = await client.callTool({ name: "stackport_stop_project", arguments: { projectId } });
    const body = result.structuredContent as { requiresConfirmation?: boolean; confirmationId?: string };
    assert.equal(body.requiresConfirmation, true);
    assert.ok(body.confirmationId);
  } finally { await client.close(); }
});
