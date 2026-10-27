import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { encryptSecret } from "../src/utils/crypto";
import { createProject, updateProject } from "../src/services/projectAdmin";
import { addProjectDomain } from "../src/services/projectDomains";
import { createProjectEnvFile } from "../src/services/projectDeploy";
import { createApiToken, revokeApiToken } from "../src/services/apiTokens";
import { issueAuthToken } from "../src/services/authTokens";
import { safeRepo } from "../src/mcp/readModel";
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

test("only the three read-only tools exist", async () => {
  const client = await connect(token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["stackport_get_project", "stackport_list_projects", "stackport_status"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  await client.close();
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
