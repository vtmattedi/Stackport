import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import type { ApiToken } from "../src/modules/identity/apiTokens";
import { createProject } from "../src/modules/projects/operations";
import { listProjectDomains } from "../src/modules/ingress/domains";
import { addManagedDomain } from "../src/modules/ingress/managedDomains";
import { GithubClient, setDefaultGithubClientForTests } from "../src/modules/github/client";
import { completeLink, completeManifest, forgetInstallationTokens, refreshRepositories, startLink, startManifest, type PreflightDeps } from "../src/modules/github/app";
import { importRepositories, MAX_IMPORT, projectForRepository, scanInstallation, uniqueProjectName } from "../src/modules/github/importer";
import { ConfirmationStore, registerWriteTools, type WriteDeps } from "../src/transports/mcp/writeTools";
import { listGithubRepositoriesView } from "../src/transports/mcp/readModel";
import { startFakeGithub, type FakeGithubWithCodes } from "./helpers/fakeGithub";
import app from "../src/app";

let fake: FakeGithubWithCodes;
let client: GithubClient;
let server: Server;
let base: string;
let adminToken: string;
const domain: PreflightDeps = { appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => true };

before(async () => {
  initializeDatabase();
  fake = (await startFakeGithub()) as FakeGithubWithCodes;
  client = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined });
  setDefaultGithubClientForTests(client);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminToken = issueAuthToken("admin");
});
after(async () => { setDefaultGithubClientForTests(null); server.close(); await fake.close(); });

const COMPOSE = { "docker-compose.yml": "services: {}" };

/** Installation 11 (acme) with a mix of repositories; installation 22 (bob) with one. */
async function world(): Promise<void> {
  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
  // Projects from earlier scenarios would take names and repositories this one expects to be free.
  db.prepare("DELETE FROM project_domains").run();
  db.prepare("DELETE FROM projects WHERE github_repo LIKE 'acme/%' OR github_repo LIKE 'bob/%' OR name LIKE 'shop%' OR name LIKE 'scan-%' OR name LIKE 'my-blog%'").run();
  db.prepare("DELETE FROM managed_domains").run();
  forgetInstallationTokens();
  const start = await startManifest("admin", { modules: [], owner: "", isPublic: false }, domain, client);
  await completeManifest(fake.issueCode("manifest"), start.state, domain, client);
  fake.installations = [
    {
      id: 11, account: { id: 1, login: "acme", type: "Organization" },
      repositories: [
        { id: 101, full_name: "acme/shop", default_branch: "main" },
        { id: 102, full_name: "acme/blog", default_branch: "main" },
        { id: 103, full_name: "acme/docs", default_branch: "main", private: true },
        { id: 104, full_name: "acme/empty" },
        { id: 105, full_name: "acme/old", default_branch: "main", archived: true },
      ],
      branches: {},
      files: { "acme/shop": COMPOSE, "acme/blog": { "deploy/compose.prod.yaml": "x", "README.md": "x" }, "acme/docs": { "README.md": "x" }, "acme/old": COMPOSE },
    },
    { id: 22, account: { id: 2, login: "bob", type: "User" }, repositories: [{ id: 201, full_name: "bob/api", default_branch: "main" }], files: { "bob/api": COMPOSE } },
  ];
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
  await refreshRepositories(11, client);
  await refreshRepositories(22, client);
}

const call = (method: string, path: string, body?: unknown, auth = true): Promise<Response> =>
  fetch(`${base}/api/github-app${path}`, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${adminToken}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- scanning

test("a scan says which repositories have a Compose file on their default branch, and which are projects already", async () => {
  await world();
  const existing = createProject({ name: "scan-existing", sourceType: "github", githubRepo: "acme/blog" }).id;
  getDatabase().prepare("UPDATE projects SET github_auth_mode = 'app', github_installation_id = 11, github_repository_id = 102 WHERE id = ?").run(existing);
  const { entries, truncated } = await scanInstallation(11, client);
  assert.equal(truncated, false);
  const by = Object.fromEntries(entries.map((e) => [e.fullName, e]));
  assert.deepEqual(by["acme/shop"].composeFiles, ["docker-compose.yml"]);
  assert.equal(by["acme/shop"].note, null);
  assert.deepEqual(by["acme/blog"].composeFiles, ["deploy/compose.prod.yaml"]);
  assert.deepEqual(by["acme/blog"].importedAs, { id: existing, name: "scan-existing" });
  assert.match(by["acme/docs"].note ?? "", /No Compose file/);
  assert.equal(by["acme/docs"].isPrivate, true);
  assert.match(by["acme/empty"].note ?? "", /no default branch/);
  assert.equal(by["acme/old"].archived, true);
  await assert.rejects(scanInstallation(999, client), /not connected/);
});

// ---- importing

test("importing creates a project for each repository with a Compose file, bound by id, on its default branch, and deploys nothing", async () => {
  await world();
  const outcomes = await importRepositories(11, [101, 102, 103, 104], null, client);
  const by = Object.fromEntries(outcomes.map((o) => [o.repositoryId, o]));
  assert.equal(by[101].status, "created");
  assert.equal(by[102].status, "created");
  assert.deepEqual([by[103].status, by[103].reason], ["skipped", "No Compose file on the default branch."]);
  assert.deepEqual([by[104].status, by[104].reason], ["skipped", "It has no default branch."]);

  const row = getDatabase().prepare("SELECT name, github_repo, auto_deploy_branch, github_auth_mode, github_installation_id, github_repository_id, source_type FROM projects WHERE id = ?").get(by[101].project!.id) as Record<string, unknown>;
  assert.deepEqual(row, { name: "shop", github_repo: "acme/shop", auto_deploy_branch: "main", github_auth_mode: "app", github_installation_id: 11, github_repository_id: 101, source_type: "github" });
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM project_deployments WHERE project_id = ?").get(by[101].project!.id) as { n: number }).n, 0, "nothing was deployed");
});

test("importing twice does not create a second project, and one that cannot be imported does not stop the others", async () => {
  await world();
  await importRepositories(11, [101], null, client);
  const again = await importRepositories(11, [101, 102, 999, "x", 201], null, client);
  const reasons = Object.fromEntries(again.map((o) => [String(o.repositoryId), `${o.status}: ${o.reason ?? ""}`]));
  assert.match(reasons["101"], /skipped: Already the project "shop"/);
  assert.match(reasons["102"], /^created/);
  assert.match(reasons["999"], /skipped: .*does not have access/);
  assert.match(reasons["NaN"], /skipped: Not a repository id/);
  assert.match(reasons["201"], /skipped: .*does not have access/, "bob's repository is not in acme's installation");
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM projects WHERE github_repository_id = 101").get() as { n: number }).n, 1);
});

test("project names are made unique, and the choice of repositories is bounded and required", async () => {
  await world();
  createProject({ name: "shop", sourceType: "upload" });
  assert.equal(uniqueProjectName("shop"), "shop-2");
  const outcomes = await importRepositories(11, [101], null, client);
  assert.equal(outcomes[0].project?.name, "shop-2");
  await assert.rejects(importRepositories(11, [], null, client), /at least one/);
  await assert.rejects(importRepositories(11, "nope", null, client), /at least one/);
  await assert.rejects(importRepositories(11, Array.from({ length: MAX_IMPORT + 1 }, (_, i) => i + 1), null, client), /at most/);
});

test("with a default managed domain, an imported project reserves its hostname", async () => {
  await world();
  addManagedDomain("example.com");
  const [outcome] = await importRepositories(11, [101], null, client);
  assert.deepEqual(listProjectDomains(outcome.project!.id).map((d) => [d.domain, d.service]), [["shop.example.com", ""]]);
});

test("the scan and import endpoints need a login and validate", async () => {
  await world();
  assert.equal((await call("POST", "/import/scan", { installationId: 11 }, false)).status, 401);
  assert.equal((await call("POST", "/import", { installationId: 11, repositoryIds: [101] }, false)).status, 401);
  assert.equal((await call("POST", "/import/scan", {})).status, 400);
  assert.equal((await call("POST", "/import/scan", { installationId: 999 })).status, 403);
  const scan = await call("POST", "/import/scan", { installationId: 11 });
  assert.equal(scan.status, 200);
  const body = (await scan.json()) as { entries: unknown[]; warning: string };
  assert.ok(body.entries.length >= 5);
  assert.match(body.warning, /controls what runs on this host/);
  const done = await call("POST", "/import", { installationId: 11, repositoryIds: [101] });
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as { outcomes: { status: string }[] }).outcomes[0].status, "created");
  assert.equal((await call("POST", "/import", { installationId: 11, repositoryIds: [] })).status, 400);
});

// ---- MCP

const tokenOf = (overrides: Partial<ApiToken> = {}): ApiToken => ({ id: 5, name: "agent", prefix: "spk_x", scopes: ["read", "write"], projectGroup: null, createdAt: "", lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides });

async function mcp(token: ApiToken) {
  const deps: WriteDeps = { getProject: () => null, rollbackTarget: () => ({ ok: false, error: "" }), start: () => null, now: Date.now };
  const server = new McpServer({ name: "t", version: "1" });
  registerWriteTools(server, token, deps, new ConfirmationStore());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(b), c.connect(a)]);
  const call2 = async (args: Record<string, unknown>) => {
    const result = await c.callTool({ name: "stackport_create_project_from_repository", arguments: args });
    return { isError: result.isError === true, text: (result.content as { text: string }[])[0]?.text ?? "", body: result.structuredContent as Record<string, unknown> | undefined };
  };
  return { call: call2, close: () => c.close() };
}

test("the repository list shows what the App can use and which are projects, and nothing else", async () => {
  await world();
  await importRepositories(11, [101], null, client);
  const view = listGithubRepositoriesView();
  const by = Object.fromEntries(view.repositories.map((r) => [r.fullName, r]));
  assert.deepEqual(Object.keys(by["acme/shop"]).sort(), ["account", "archived", "defaultBranch", "fullName", "private", "project"]);
  assert.equal(by["acme/shop"].account, "acme");
  assert.equal(by["acme/shop"].project?.name, "shop");
  assert.equal(by["acme/blog"].project, null);
  assert.equal(by["bob/api"].account, "bob");
  getDatabase().prepare("UPDATE github_app_installations SET status = 'suspended' WHERE installation_id = 22").run();
  assert.ok(!listGithubRepositoriesView().repositories.some((r) => r.fullName === "bob/api"), "a suspended installation's repositories are not offered");
});

test("creating a project from a repository over MCP is two steps, creates exactly what was described, and deploys nothing", async () => {
  await world();
  const h = await mcp(tokenOf());
  const preview = await h.call({ repository: "acme/blog", name: "my-blog" });
  assert.equal(preview.isError, false);
  assert.match(String(preview.body?.["summary"]), /Create the project "my-blog" from acme\/blog \(branch main\)/);
  assert.match(String(preview.body?.["summary"]), /controls what runs on this host/);
  assert.equal(projectForRepository(102), null, "nothing was created");

  const confirmationId = String(preview.body?.["confirmationId"]);
  const other = await h.call({ repository: "acme/blog", name: "another-name", confirmationId });
  assert.equal(other.isError, true, "a confirmation is only good for what it described");
  const created = await h.call({ repository: "acme/blog", name: "my-blog", confirmationId: String((await h.call({ repository: "acme/blog", name: "my-blog" })).body?.["confirmationId"]) });
  assert.equal(created.body?.["created"], true);
  const project = projectForRepository(102);
  assert.equal(project?.name, "my-blog");
  assert.match(String(created.body?.["note"]), /has not been deployed/);
  assert.equal((await h.call({ repository: "acme/blog" })).isError, true, "a second project from the same repository is refused");
  await h.close();
});

test("bad requests are refused in the preview: an unknown repository, and one from a suspended installation", async () => {
  await world();
  const h = await mcp(tokenOf());
  const unknown = await h.call({ repository: "nobody/nothing" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /not a repository the GitHub App can use/);
  assert.match(unknown.text, /acme\/shop/, "and says what it can use");
  getDatabase().prepare("UPDATE github_app_installations SET status = 'suspended' WHERE installation_id = 22").run();
  assert.equal((await h.call({ repository: "bob/api" })).isError, true);
  await h.close();
});

test("a token limited to a project group creates the project inside that group, and cannot choose another", async () => {
  await world();
  const h = await mcp(tokenOf({ projectGroup: "staging" }));
  assert.match(String((await h.call({ repository: "acme/shop", group: "prod" })).text), /only create projects in the group "staging"/);
  const preview = await h.call({ repository: "acme/shop" });
  assert.match(String(preview.body?.["summary"]), /in the group "staging"/);
  const created = await h.call({ repository: "acme/shop", confirmationId: String(preview.body?.["confirmationId"]) });
  const id = Number(created.body?.["projectId"]);
  assert.equal((getDatabase().prepare("SELECT group_name FROM projects WHERE id = ?").get(id) as { group_name: string }).group_name, "staging");
  await h.close();
});
