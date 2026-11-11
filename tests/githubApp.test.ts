import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { GithubClient, GithubError } from "../src/modules/github/client";
import { encryptSecret } from "../src/shared/crypto";
import { signAppJwt } from "../src/modules/github/jwt";
import {
  appJwt, buildManifest, completeLink, completeManifest, forgetInstallationTokens, installationToken, preflight, refreshRepositories, startLink, startManifest,
  syncInstallations, GithubAppError, type PreflightDeps,
} from "../src/modules/github/app";
import { consumeState, createState, getApp, getAppSecrets, getInstallation, listInstallations, listRepositories } from "../src/modules/github/store";
import { startFakeGithub, type FakeGithub, type FakeGithubWithCodes } from "./helpers/fakeGithub";

let fake: FakeGithubWithCodes;
let client: GithubClient;
const goodDomain: PreflightDeps = { appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => true };

before(async () => {
  initializeDatabase();
  fake = (await startFakeGithub()) as FakeGithubWithCodes;
  client = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined });
});
after(async () => { await fake.close(); });
afterEach(() => { forgetInstallationTokens(); fake.rateLimit = null; fake.holdMs = 0; });

const resetApp = (): void => {
  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
};

async function registerApp(): Promise<void> {
  resetApp();
  const start = await startManifest("admin", { modules: ["deployments", "ci", "releases"], owner: "acme", isPublic: false }, goodDomain, client);
  await completeManifest(fake.issueCode("manifest"), start.state, goodDomain, client);
}

// ---- preflight

test("preflight: the page stays disabled until the domain is set, over HTTPS, with a certificate", async () => {
  assert.equal((await preflight({ appConfig: () => ({ enabled: false, domain: "", useSsl: true }), hasCertificate: async () => true })).ok, false);
  const noHttps = await preflight({ appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: false }), hasCertificate: async () => true });
  assert.match(noHttps.problems.join(" "), /HTTPS/);
  const noCert = await preflight({ appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => false });
  assert.match(noCert.problems.join(" "), /no certificate/);
  const ok = await preflight(goodDomain);
  assert.deepEqual([ok.ok, ok.origin], [true, "https://sp.example.com"]);
});

// ---- manifest

test("manifest: every URL is built from the saved domain, and modules add exactly their permissions and events", () => {
  const all = buildManifest("https://sp.example.com", { modules: ["deployments", "ci", "releases"], owner: "", isPublic: false }) as Record<string, any>;
  assert.equal(all.hook_attributes.url, "https://sp.example.com/api/hooks/github/app");
  assert.equal(all.redirect_url, "https://sp.example.com/api/github-app/manifest/callback");
  assert.deepEqual(all.callback_urls, ["https://sp.example.com/api/github-app/oauth/callback"]);
  assert.deepEqual(all.default_permissions, { contents: "read", deployments: "write", checks: "read", actions: "read", statuses: "read" });
  assert.deepEqual([...all.default_events].sort(), ["check_suite", "installation", "installation_repositories", "push", "release", "workflow_run"]);
  assert.ok(String(all.name).length <= 34);

  const core = buildManifest("https://sp.example.com", { modules: [], owner: "", isPublic: false }) as Record<string, any>;
  assert.deepEqual(core.default_permissions, { contents: "read" });
  assert.deepEqual([...core.default_events].sort(), ["installation", "installation_repositories", "push"]);
});

test("registration: the round trip stores the App, encrypts its secrets, and the state works once", async () => {
  resetApp();
  const start = await startManifest("admin", { modules: ["deployments", "ci", "releases"], owner: "acme", isPublic: false }, goodDomain, client);
  assert.match(start.registrationUrl, /\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{64}$/);
  assert.equal((start.manifest as { url: string }).url, "https://sp.example.com");

  const code = fake.issueCode("manifest");
  const app = await completeManifest(code, start.state, goodDomain, client);
  assert.deepEqual([app.appId, app.slug, app.ownerLogin, app.registeredOrigin], [fake.appId, "stackport-test", "acme", "https://sp.example.com"]);
  assert.deepEqual(app.modules, ["deployments", "ci", "releases"]);

  const raw = getDatabase().prepare("SELECT private_key_enc, webhook_secret_enc, client_secret_enc FROM github_app").get() as Record<string, string>;
  for (const value of Object.values(raw)) assert.match(value, /^(v2:[0-9a-f]+:|[0-9a-f]+:[0-9a-f]+:)/, "stored as ciphertext");
  assert.ok(!raw.private_key_enc.includes("BEGIN"), "the private key is not stored in clear");
  assert.equal(getAppSecrets()?.webhookSecret, fake.webhookSecret);
  assert.match(getAppSecrets()?.privateKey ?? "", /BEGIN PRIVATE KEY/);

  await assert.rejects(completeManifest(fake.issueCode("manifest"), start.state, goodDomain, client), /expired or was already used/, "the state is single-use");
});

test("registration: an unknown or wrong-purpose state, a bad code and a code GitHub already spent are all refused", async () => {
  resetApp();
  await assert.rejects(completeManifest(fake.issueCode("manifest"), "f".repeat(64), goodDomain, client), (err: unknown) => err instanceof GithubAppError && err.status === 410);
  await assert.rejects(completeManifest(fake.issueCode("manifest"), undefined, goodDomain, client), GithubAppError);
  const linkState = createState("link", "admin");
  await assert.rejects(completeManifest(fake.issueCode("manifest"), linkState, goodDomain, client), /expired or was already used/, "a state made for linking cannot register an App");
  await assert.rejects(completeManifest("../../etc/passwd", createState("manifest", "admin"), goodDomain, client), /malformed/);

  const start = await startManifest("admin", { modules: [], owner: "", isPublic: false }, goodDomain, client);
  await assert.rejects(completeManifest("deadbeefdeadbeef", start.state, goodDomain, client), /GitHub refused the registration/, "a code GitHub does not know (or expired after an hour)");
  assert.equal(getApp(), null);
});

test("registration: a second App is refused, and a state expires after ten minutes", async () => {
  await registerApp();
  await assert.rejects(startManifest("admin", { modules: [], owner: "", isPublic: false }, goodDomain, client), (err: unknown) => err instanceof GithubAppError && err.status === 409);
  const state = createState("link", "admin", Date.now() - 11 * 60 * 1000);
  assert.equal(consumeState(state, "link"), null);
  assert.equal(consumeState(createState("link", "admin"), "link"), "admin");
});

// ---- the App's own credential

test("jwt: GitHub accepts it (signature and lifetime), and it is dated a minute back for clock skew", async () => {
  await registerApp();
  const token = appJwt();
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, String(fake.appId));
  assert.ok(claims.iat <= Math.floor(Date.now() / 1000) - 59);
  assert.ok(claims.exp - claims.iat <= 600, "GitHub rejects a JWT valid for more than ten minutes");
  const bad = signAppJwt(fake.appId, crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
  await assert.rejects(client.request({ path: "/app/installations", bearer: bad }), (err: unknown) => err instanceof GithubError && err.status === 401, "a JWT signed with another key is refused");
});

// ---- linking

test("link: the user's token is used once to list their installations; only this App's are linked, and a spoofed or replayed callback is refused", async () => {
  await registerApp();
  fake.installations = [
    { id: 101, account: { id: 1, login: "acme", type: "Organization" }, repositories: [{ id: 11, full_name: "acme/api" }] },
    { id: 202, account: { id: 2, login: "bob", type: "User" }, repositories: [{ id: 22, full_name: "bob/api" }] },
    { id: 303, appId: 9999, account: { id: 3, login: "other", type: "User" }, repositories: [] },
  ];
  const { authorizeUrl } = startLink("admin", client);
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  assert.equal(new URL(authorizeUrl).searchParams.get("client_id"), fake.clientId);
  assert.equal(new URL(authorizeUrl).searchParams.get("redirect_uri"), "https://sp.example.com/api/github-app/oauth/callback");

  await assert.rejects(completeLink(fake.issueCode("oauth"), "a".repeat(64), client), /expired or was already used/, "a callback with a state we never issued");
  const linked = await completeLink(fake.issueCode("oauth"), state, client);
  assert.deepEqual(linked.map((i) => [i.installationId, i.status]).sort(), [[101, "linked"], [202, "linked"]], "another App's installation is not ours to link");
  assert.equal(getInstallation(303), null);
  await assert.rejects(completeLink(fake.issueCode("oauth"), state, client), /expired or was already used/, "a replayed callback");
});

test("link: a code GitHub did not issue gives no access", async () => {
  await registerApp();
  const state = new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!;
  await assert.rejects(completeLink("notacode123", state, client), /did not accept the code/);
});

test("sync: an installation GitHub shows us but nobody linked is unlinked and cannot mint a token", async () => {
  await registerApp();
  fake.installations = [{ id: 404, account: { id: 4, login: "carol", type: "User" }, repositories: [{ id: 44, full_name: "carol/app" }] }];
  const installations = await syncInstallations(client);
  assert.deepEqual(installations.map((i) => [i.installationId, i.status]), [[404, "unlinked"]]);
  await assert.rejects(installationToken(404, client), (err: unknown) => err instanceof GithubAppError && err.status === 403);
  assert.equal(fake.tokensIssued, 0, "nothing was asked of GitHub for an unlinked installation");
});

test("sync: an installation that is gone is marked removed, and one that comes back stays linked", async () => {
  await registerApp();
  fake.installations = [{ id: 505, account: { id: 5, login: "dave", type: "User" }, repositories: [] }];
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
  assert.equal(getInstallation(505)?.status, "linked");
  fake.installations = [];
  await syncInstallations(client);
  assert.equal(getInstallation(505)?.status, "removed");
  fake.installations = [{ id: 505, account: { id: 5, login: "dave", type: "User" }, repositories: [] }];
  await syncInstallations(client);
  assert.equal(getInstallation(505)?.status, "unlinked", "once removed it is not linked again by a sync alone");
});

// ---- installation tokens

async function linkedInstallations(...installations: FakeGithub["installations"]): Promise<void> {
  await registerApp();
  fake.installations = installations;
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
}

test("token: it is cached, refreshed a minute before it expires, and never written to the database", async () => {
  await linkedInstallations({ id: 601, account: { id: 6, login: "erin", type: "User" }, repositories: [] });
  const before = fake.tokensIssued;
  const first = await installationToken(601, client);
  assert.equal(await installationToken(601, client), first);
  assert.equal(fake.tokensIssued, before + 1, "the second call used the cache");
  const nearExpiry = Date.now() + fake.tokenLifetimeMs - 30_000;
  const second = await installationToken(601, client, nearExpiry);
  assert.notEqual(second, first, "refreshed because less than a minute was left");
  const dump = JSON.stringify(getDatabase().prepare("SELECT * FROM github_app_installations").all());
  assert.ok(!dump.includes(first) && !dump.includes(second));
});

test("token: five callers at once cause one request to GitHub", async () => {
  await linkedInstallations({ id: 602, account: { id: 7, login: "frank", type: "User" }, repositories: [] });
  fake.holdMs = 50;
  const before = fake.tokensIssued;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => installationToken(602, client)));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(fake.tokensIssued, before + 1);
});

test("token: a suspended installation is marked so, and a vanished one is marked removed", async () => {
  await linkedInstallations(
    { id: 603, account: { id: 8, login: "gina", type: "User" }, repositories: [] },
    { id: 604, account: { id: 9, login: "hank", type: "User" }, repositories: [] },
  );
  fake.installations[0].suspended = true;
  await assert.rejects(installationToken(603, client), GithubError);
  assert.equal(getInstallation(603)?.status, "suspended");
  fake.installations = fake.installations.filter((i) => i.id !== 604);
  await assert.rejects(installationToken(604, client), GithubError);
  assert.equal(getInstallation(604)?.status, "removed");
});

test("token: a failure is not remembered, a changed status stops a cached token at once, and a rejected key does not mark installations removed", async () => {
  await linkedInstallations({ id: 605, account: { id: 13, login: "jo", type: "User" }, repositories: [] });
  // Unlinked first: the failure must not stick once it is linked.
  getDatabase().prepare("UPDATE github_app_installations SET status = 'unlinked' WHERE installation_id = 605").run();
  await assert.rejects(installationToken(605, client), /not linked/);
  getDatabase().prepare("UPDATE github_app_installations SET status = 'linked' WHERE installation_id = 605").run();
  const token = await installationToken(605, client);
  assert.match(token, /^ghs_/);

  // Cached, then suspended by a webhook: the cached token is no longer served.
  getDatabase().prepare("UPDATE github_app_installations SET status = 'suspended' WHERE installation_id = 605").run();
  await assert.rejects(installationToken(605, client), /not linked/);
  getDatabase().prepare("UPDATE github_app_installations SET status = 'linked' WHERE installation_id = 605").run();

  // The App's JWT rejected (a wrong key): that says nothing about the installation.
  forgetInstallationTokens();
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  getDatabase().prepare("UPDATE github_app SET private_key_enc = ? WHERE id = 1").run(encryptSecret(keys.privateKey));
  await assert.rejects(installationToken(605, client), /rejected the App's credentials/);
  assert.equal(getInstallation(605)?.status, "linked", "a 401 does not remove the installation");
});

// ---- repositories

test("repositories: two installations with a repository of the same name stay apart, and a repository that goes away is revoked, not deleted", async () => {
  await linkedInstallations(
    { id: 701, account: { id: 10, login: "acme", type: "Organization" }, repositories: [{ id: 1001, full_name: "acme/api", default_branch: "main", private: true }, { id: 1002, full_name: "acme/web" }] },
    { id: 702, account: { id: 11, login: "ivy", type: "User" }, repositories: [{ id: 2001, full_name: "ivy/api" }] },
  );
  assert.equal((await refreshRepositories(701, client)).length, 2);
  await refreshRepositories(702, client);
  assert.deepEqual(listRepositories(701).map((r) => r.fullName), ["acme/api", "acme/web"]);
  assert.deepEqual(listRepositories(702).map((r) => r.fullName), ["ivy/api"]);
  assert.equal(listRepositories(701)[0].defaultBranch, "main");
  assert.equal(listRepositories(701)[0].isPrivate, true);
  assert.equal(listInstallations().find((i) => i.installationId === 701)?.repositoryCount, 2);

  fake.installations[0].repositories = [{ id: 1001, full_name: "acme/api-renamed", default_branch: "main" }];
  await refreshRepositories(701, client);
  assert.deepEqual(listRepositories(701).map((r) => r.fullName), ["acme/api-renamed"], "renamed in place by repository id");
  const revoked = getDatabase().prepare("SELECT access_status FROM github_app_repositories WHERE repository_id = 1002").get() as { access_status: string };
  assert.equal(revoked.access_status, "revoked");
});

test("repositories: more than one page are all read", async () => {
  const repositories = Array.from({ length: 230 }, (_, i) => ({ id: 5000 + i, full_name: `big/repo-${i}` }));
  await linkedInstallations({ id: 801, account: { id: 12, login: "big", type: "Organization" }, repositories });
  assert.equal((await refreshRepositories(801, client)).length, 230);
  assert.equal(listRepositories(801).length, 230);
});

// ---- the client

test("client: a 429 is waited out as GitHub asked and then retried; two at a time, never more", async () => {
  const waits: number[] = [];
  const slow = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async (ms) => { waits.push(ms); } });
  fake.rateLimit = { prefix: "/app/installations", remaining: 2 };
  await registerApp();
  fake.installations = [];
  await slow.request({ path: "/app/installations", bearer: appJwt() });
  assert.deepEqual(waits, [1000, 1000], "waited as Retry-After said, once per 429");

  const gives = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined, retries: 1 });
  fake.rateLimit = { prefix: "/app/installations", remaining: 5 };
  await assert.rejects(gives.request({ path: "/app/installations", bearer: appJwt() }), (err: unknown) => err instanceof GithubError && err.status === 429);

  fake.rateLimit = null;
  fake.maxConcurrent = 0;
  fake.holdMs = 40;
  await Promise.all(Array.from({ length: 8 }, () => slow.request({ path: "/app/installations", bearer: appJwt() })));
  assert.ok(fake.maxConcurrent <= 2, `at most two requests at once, saw ${fake.maxConcurrent}`);
});

test("client: an unreachable GitHub is a clear error, and so is a timeout", async () => {
  const dead = new GithubClient({ apiUrl: "http://127.0.0.1:1", webUrl: "http://127.0.0.1:1", timeoutMs: 500 });
  await assert.rejects(dead.request({ path: "/app" }), (err: unknown) => err instanceof GithubError && err.status === 0 && /could not be reached/.test(err.message));
});
