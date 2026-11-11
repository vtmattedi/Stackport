import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { encryptSecret } from "../src/shared/crypto";
import { GithubClient, setDefaultGithubClientForTests } from "../src/modules/github/client";
import { completeLink, completeManifest, forgetInstallationTokens, refreshRepositories, startLink, startManifest, type PreflightDeps } from "../src/modules/github/app";
import { appTokenForProject, candidatesForRepo, inspectRepository, listRepositoryBranches, resolveAppRepository } from "../src/modules/github/binding";
import { apiTokenForProject, tokenForProject } from "../src/modules/automation/githubPolling";
import { getProjectById } from "../src/modules/deployments/operations";
import { startFakeGithub, type FakeGithubWithCodes } from "./helpers/fakeGithub";
import app from "../src/app";

let fake: FakeGithubWithCodes;
let client: GithubClient;
let server: Server;
let base: string;
let token: string;
const domain: PreflightDeps = { appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => true };

before(async () => {
  initializeDatabase();
  fake = (await startFakeGithub()) as FakeGithubWithCodes;
  client = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined });
  setDefaultGithubClientForTests(client);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = issueAuthToken("admin");

  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
  const start = await startManifest("admin", { modules: [], owner: "", isPublic: false }, domain, client);
  await completeManifest(fake.issueCode("manifest"), start.state, domain, client);
  fake.installations = [
    {
      id: 11, account: { id: 1, login: "acme", type: "Organization" },
      repositories: [{ id: 101, full_name: "acme/shop", default_branch: "main" }, { id: 102, full_name: "acme/blog", default_branch: "main" }],
      branches: { "acme/shop": ["main", "staging"] },
      files: { "acme/shop": { "docker-compose.yml": "services: {}", "deploy/compose.prod.yaml": "services: {}", ".env.example": "# comment\nDATABASE_URL=postgres://u:p@h/db\nexport API_KEY=abc\nEMPTY=\n  SPACED = 1\n", "README.md": "x" } },
    },
    { id: 22, account: { id: 2, login: "bob", type: "User" }, repositories: [{ id: 201, full_name: "bob/api" }] },
  ];
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
  await refreshRepositories(11, client);
  await refreshRepositories(22, client);
});
after(async () => { setDefaultGithubClientForTests(null); server.close(); await fake.close(); });

const call = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- the wizard's reads

test("the repository must be one the App can use: an unlinked installation or a repository outside the grant is refused", () => {
  assert.equal(resolveAppRepository(11, 101).fullName, "acme/shop");
  assert.throws(() => resolveAppRepository(11, 201), /does not have access/, "bob's repository is not in acme's installation");
  assert.throws(() => resolveAppRepository(999, 101), /not connected/);
  assert.throws(() => resolveAppRepository("11", 101), /Choose an installation/);
});

test("branches are read with the installation token, and a branch's Compose files and .env.example names are found without reading values", async () => {
  const repository = resolveAppRepository(11, 101);
  assert.deepEqual((await listRepositoryBranches(repository, client)).map((b) => b.name), ["main", "staging"]);
  const found = await inspectRepository(repository, "main", client);
  assert.deepEqual(found.composeFiles.sort(), ["deploy/compose.prod.yaml", "docker-compose.yml"]);
  assert.deepEqual(found.envVariableNames, ["DATABASE_URL", "API_KEY", "EMPTY", "SPACED"]);
  assert.ok(!JSON.stringify(found).includes("postgres://"), "values are not returned");
});

test("the same reads work over HTTP, and a repository id with the wrong installation is refused", async () => {
  const ok = await call("GET", "/github-app/repositories/101/branches?installationId=11");
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as { branches: { name: string }[] }).branches.map((b) => b.name), ["main", "staging"]);
  assert.equal((await call("GET", "/github-app/repositories/101/branches?installationId=22")).status, 404);
  assert.equal((await call("GET", "/github-app/repositories/101/inspect?installationId=11")).status, 400, "a branch is required");
  const inspect = await call("GET", "/github-app/repositories/101/inspect?installationId=11&branch=main");
  assert.equal(inspect.status, 200);
});

// ---- creating a project from a repository

test("a project is created from a repository the App can use, bound by id, with no token", async () => {
  const res = await call("POST", "/projects", { name: "from-app", githubApp: { installationId: 11, repositoryId: 101 }, githubCredentialId: 5 });
  assert.equal(res.status, 201);
  const project = (await res.json()) as { id: number; githubRepo: string; githubAuthMode: string; githubInstallationId: number; githubRepositoryId: number; githubCredentialId: number | null };
  assert.deepEqual([project.githubRepo, project.githubAuthMode, project.githubInstallationId, project.githubRepositoryId], ["acme/shop", "app", 11, 101]);
  assert.equal(project.githubCredentialId, null, "a typed token is ignored for an App project");
  assert.equal((await call("POST", "/projects", { name: "bad", githubApp: { installationId: 11, repositoryId: 201 } })).status, 404);
});

// ---- the resolver

test("an App project gets an installation token and never a stored one; a token project is unchanged", async () => {
  const db = getDatabase();
  const secret = encryptSecret("ghp_plain_pat");
  db.prepare("INSERT INTO credentials (type, alias, secret_enc, username) VALUES ('github', 'pat-for-resolver', ?, 'octo')").run(secret);
  const credentialId = (db.prepare("SELECT id FROM credentials WHERE alias = 'pat-for-resolver'").get() as { id: number }).id;
  const created = (await (await call("POST", "/projects", { name: "resolver-pat", githubRepo: "acme/shop", githubCredentialId: credentialId })).json()) as { id: number };
  const patProject = getProjectById(created.id)!;
  assert.equal(await apiTokenForProject(patProject), "ghp_plain_pat");
  assert.equal(tokenForProject(patProject), "ghp_plain_pat");

  const moved = await call("PUT", `/projects/${created.id}/github-auth`, { mode: "app" });
  assert.equal(moved.status, 200, await moved.clone().text());
  const appProject = getProjectById(created.id)!;
  assert.equal(appProject.githubAuthMode, "app");
  assert.equal(appProject.githubCredentialId, credentialId, "the token is kept, so moving back loses nothing");
  const installationToken = await apiTokenForProject(appProject);
  assert.match(installationToken ?? "", /^ghs_/);
  assert.equal(tokenForProject(appProject), null, "the synchronous token path gives an App project nothing");
});

test("no silent fallback: when the App loses the repository or the installation, the project's calls fail instead of using its old token", async () => {
  const db = getDatabase();
  const created = (await (await call("POST", "/projects", { name: "no-fallback", githubApp: { installationId: 11, repositoryId: 102 } })).json()) as { id: number };
  db.prepare("UPDATE projects SET github_credential_id = (SELECT id FROM credentials WHERE alias = 'pat-for-resolver') WHERE id = ?").run(created.id);
  assert.match(await appTokenForProject(created.id, client), /^ghs_/);

  db.prepare("UPDATE github_app_repositories SET access_status = 'revoked' WHERE repository_id = 102").run();
  await assert.rejects(appTokenForProject(created.id, client), /no longer has access to this repository/);
  await assert.rejects(apiTokenForProject(getProjectById(created.id)!), /no longer has access/);

  db.prepare("UPDATE github_app_repositories SET access_status = 'granted' WHERE repository_id = 102").run();
  db.prepare("UPDATE github_app_installations SET status = 'suspended' WHERE installation_id = 11").run();
  forgetInstallationTokens();
  await assert.rejects(appTokenForProject(created.id, client), /not linked/);
  db.prepare("UPDATE github_app_installations SET status = 'linked' WHERE installation_id = 11").run();
});

// ---- moving a project between a token and the App

test("moving to the App needs a repository the App can really read, and the match is by name and id", async () => {
  const created = (await (await call("POST", "/projects", { name: "mismatch", githubRepo: "nobody/unknown" })).json()) as { id: number };
  const none = await call("PUT", `/projects/${created.id}/github-auth`, { mode: "app" });
  assert.equal(none.status, 404);
  assert.match(((await none.json()) as { error: string }).error, /No connected installation/);

  const wrong = await call("PUT", `/projects/${created.id}/github-auth`, { mode: "app", installationId: 11, repositoryId: 101 });
  assert.equal(wrong.status, 400, "acme/shop is not nobody/unknown");

  getDatabase().prepare("UPDATE projects SET github_repo = 'acme/shop' WHERE id = ?").run(created.id);
  fake.installations[0].repositories = fake.installations[0].repositories.filter((r) => r.id !== 101);
  forgetInstallationTokens();
  const gone = await call("PUT", `/projects/${created.id}/github-auth`, { mode: "app", installationId: 11, repositoryId: 101 });
  assert.equal(gone.status, 403, "the cache says yes but GitHub says no: the real call decides");
  assert.equal(getProjectById(created.id)?.githubAuthMode, null, "nothing was changed");
  fake.installations[0].repositories.push({ id: 101, full_name: "acme/shop", default_branch: "main" });
});

test("two installations that can both use a repository ask the admin to choose", async () => {
  fake.installations[1].repositories.push({ id: 301, full_name: "acme/shared" });
  fake.installations[0].repositories.push({ id: 302, full_name: "acme/shared" });
  forgetInstallationTokens();
  await refreshRepositories(11, client);
  await refreshRepositories(22, client);
  assert.equal(candidatesForRepo("ACME/shared").length, 2, "case-insensitive");
  const created = (await (await call("POST", "/projects", { name: "ambiguous", githubRepo: "acme/shared" })).json()) as { id: number };
  const res = await call("PUT", `/projects/${created.id}/github-auth`, { mode: "app" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { candidates: unknown[] }).candidates.length, 2);
});

test("moving back to a token is one call and changes only the mode", async () => {
  const created = (await (await call("POST", "/projects", { name: "round-trip", githubApp: { installationId: 11, repositoryId: 101 } })).json()) as { id: number };
  const back = await call("PUT", `/projects/${created.id}/github-auth`, { mode: "token" });
  assert.equal(back.status, 200);
  const project = getProjectById(created.id)!;
  assert.deepEqual([project.githubAuthMode, project.githubRepo, project.githubInstallationId], [null, "acme/shop", null]);
  assert.equal((await call("PUT", `/projects/${created.id}/github-auth`, { mode: "nonsense" })).status, 400);
  assert.equal((await call("PUT", "/projects/999999/github-auth", { mode: "token" })).status, 404);
});

test("an App project's repository cannot be renamed under its binding; after moving back to a token it can", async () => {
  const created = (await (await call("POST", "/projects", { name: "rename-guard", githubApp: { installationId: 11, repositoryId: 101 } })).json()) as { id: number };
  const refused = await call("PATCH", `/projects/${created.id}`, { githubRepo: "acme/blog" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /Move it back to a token/);
  assert.equal(getProjectById(created.id)?.githubRepo, "acme/shop", "nothing changed");
  assert.equal((await call("PATCH", `/projects/${created.id}`, { githubRepo: "ACME/Shop", name: "rename-guard-2" })).status, 200, "the same repository, in another case, and other fields are fine");
  await call("PUT", `/projects/${created.id}/github-auth`, { mode: "token" });
  assert.equal((await call("PATCH", `/projects/${created.id}`, { githubRepo: "acme/blog" })).status, 200);
});

test("the App cannot be forgotten while a project still deploys through it", async () => {
  const res = await call("DELETE", "/github-app");
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /still deploy through the App/);
});
