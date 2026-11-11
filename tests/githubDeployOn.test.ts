import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { actionRegistry, projectRepoKey } from "../src/modules/actions/registry";
import { clearPendingAutoDeploy } from "../src/modules/automation/autoDeploy";
import { GithubClient } from "../src/modules/github/client";
import { completeLink, completeManifest, forgetInstallationTokens, refreshRepositories, startLink, startManifest, type PreflightDeps } from "../src/modules/github/app";
import { deployRelease, evaluateCi, holdForCi, MAX_HOLD_MS, modeAvailable, NO_CHECKS_GRACE_MS, settleRepository, sweepHeldCommits } from "../src/modules/github/ci";
import { getAppSecrets } from "../src/modules/github/store";
import { processDeliveryAsync, receiveAppDelivery } from "../src/modules/github/webhook";
import { startFakeGithub, type FakeGithubWithCodes } from "./helpers/fakeGithub";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { unbindProjectFromApp } from "../src/modules/github/binding";
import app from "../src/app";
import type { AddressInfo } from "net";
import type { Server } from "http";

let fake: FakeGithubWithCodes;
let client: GithubClient;
let counter = 0;
const domain: PreflightDeps = { appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => true };
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const KEY = (s: string): string => `acme/shop@${s}`;

let server: Server;
let base: string;
let token: string;

before(async () => {
  initializeDatabase();
  fake = (await startFakeGithub()) as FakeGithubWithCodes;
  client = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = issueAuthToken("admin");
});
after(async () => { server.close(); await fake.close(); });

async function world(modules: string[] = ["ci", "releases"], permissions: Record<string, string> = { contents: "read", checks: "read", statuses: "read", actions: "read" }): Promise<void> {
  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_states", "github_app_deliveries"]) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("UPDATE projects SET github_auth_mode = NULL, github_pending_ci_sha = NULL").run();
  forgetInstallationTokens();
  fake.checkRuns = {}; fake.combinedStatus = {}; fake.refs = {};
  const start = await startManifest("admin", { modules: modules as never, owner: "", isPublic: false }, domain, client);
  await completeManifest(fake.issueCode("manifest"), start.state, domain, client);
  // The fake reports the modules it was asked for through the permissions and events GitHub returns for the App.
  db.prepare("UPDATE github_app SET modules_json = ? WHERE id = 1").run(JSON.stringify(modules));
  fake.installations = [{ id: 11, account: { id: 1, login: "acme", type: "Organization" }, permissions, repositories: [{ id: 101, full_name: "acme/shop", default_branch: "main" }] }];
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
  await refreshRepositories(11, client);
}

function project(name: string, mode: "push" | "ci" | "release" | null): number {
  const { id } = createProject({ name, sourceType: "github", githubRepo: "acme/shop" });
  getDatabase().prepare("UPDATE projects SET github_auth_mode = 'app', github_installation_id = 11, github_repository_id = 101, auto_deploy_branch = 'main', github_deploy_on = ? WHERE id = ?").run(mode, id);
  return id;
}
function holdSlot(projectId: number): () => void {
  let release!: () => void;
  actionRegistry.tryStart(projectRepoKey(projectId), "build", { projectId }, () => new Promise((resolve) => { release = () => resolve({ ok: true, output: "" }); }));
  return release;
}
const row = (id: number): { pending_ci_sha: string | null; pending_deploy_sha: string | null } =>
  getDatabase().prepare("SELECT github_pending_ci_sha AS pending_ci_sha, pending_deploy_sha FROM projects WHERE id = ?").get(id) as { pending_ci_sha: string | null; pending_deploy_sha: string | null };
const blocked = (id: number): string[] => (getDatabase().prepare("SELECT blocked_reason FROM project_deployments WHERE project_id = ? AND status = 'failed'").all(id) as { blocked_reason: string }[]).map((r) => r.blocked_reason);

async function deliver(event: string, payload: Record<string, unknown>): Promise<string | null> {
  const body = JSON.stringify(payload);
  const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const secret = getAppSecrets()!.webhookSecret;
  const { deliveryId } = receiveAppDelivery(Buffer.from(body), { signature: "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"), deliveryId: id, event });
  if (!deliveryId) return null;
  await processDeliveryAsync(deliveryId, client);
  return (getDatabase().prepare("SELECT status || ': ' || COALESCE(last_error, '') AS r FROM github_app_deliveries WHERE delivery_id = ?").get(deliveryId) as { r: string }).r;
}
const push = (s: string): Record<string, unknown> => ({ ref: "refs/heads/main", after: s, deleted: false, installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" }, head_commit: { message: "m", author: { name: "a" }, timestamp: "2026-11-10T10:00:00Z" } });

// ---- reading a commit's checks

test("a commit's checks are none, pending, failed or successful, and a failure outranks anything still running", async () => {
  await world();
  const state = (s: string) => evaluateCi(11, "acme/shop", s, client);
  assert.equal(await state(sha(1)), "none");
  fake.checkRuns[KEY(sha(2))] = [{ status: "in_progress", conclusion: null }];
  assert.equal(await state(sha(2)), "pending");
  fake.checkRuns[KEY(sha(3))] = [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }, { status: "completed", conclusion: "neutral" }];
  assert.equal(await state(sha(3)), "success", "skipped and neutral are not failures");
  fake.checkRuns[KEY(sha(4))] = [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }];
  assert.equal(await state(sha(4)), "failed");
  fake.checkRuns[KEY(sha(5))] = [{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "timed_out" }];
  assert.equal(await state(sha(5)), "failed", "no point waiting for the rest once one has failed");
  fake.combinedStatus[KEY(sha(6))] = { state: "failure", total_count: 2 };
  assert.equal(await state(sha(6)), "failed", "commit statuses count too");
  fake.combinedStatus[KEY(sha(7))] = { state: "pending", total_count: 1 };
  assert.equal(await state(sha(7)), "pending");
  fake.checkRuns[KEY(sha(8))] = [{ status: "completed", conclusion: "success" }];
  fake.combinedStatus[KEY(sha(8))] = { state: "success", total_count: 1 };
  assert.equal(await state(sha(8)), "success");
  fake.checkRuns[KEY(sha(9))] = [{ status: "completed", conclusion: "cancelled" }];
  assert.equal(await state(sha(9)), "failed");
});

// ---- M2: deploy after CI

test("a push to a project that waits for checks is held, then deploys when they pass", async () => {
  await world();
  const id = project("ci-ok", "ci");
  const release = holdSlot(id);
  fake.checkRuns[KEY(sha(10))] = [{ status: "in_progress", conclusion: null }];
  const result = await deliver("push", push(sha(10)));
  assert.match(result ?? "", /processed: .*waiting for checks/);
  assert.equal(row(id).pending_ci_sha, sha(10), "held");
  assert.equal(row(id).pending_deploy_sha, null, "not deploying yet");

  // The suite finishes: GitHub sends check_suite completed, and the commit is released to deploy.
  fake.checkRuns[KEY(sha(10))] = [{ status: "completed", conclusion: "success" }];
  const done = await deliver("check_suite", { action: "completed", installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" }, check_suite: { head_sha: sha(10), status: "completed", conclusion: "success" } });
  assert.match(done ?? "", /processed: deployed/);
  assert.equal(row(id).pending_ci_sha, null);
  assert.equal(row(id).pending_deploy_sha, sha(10), "queued behind the running action: it deploys when that ends");
  clearPendingAutoDeploy(id); release();
});

test("a push whose checks have already passed deploys at once", async () => {
  await world();
  const id = project("ci-already", "ci");
  const release = holdSlot(id);
  fake.checkRuns[KEY(sha(11))] = [{ status: "completed", conclusion: "success" }];
  assert.match((await deliver("push", push(sha(11)))) ?? "", /processed/);
  assert.equal(row(id).pending_deploy_sha, sha(11));
  assert.equal(row(id).pending_ci_sha, null);
  clearPendingAutoDeploy(id); release();
});

test("failing checks mean no deploy, and the admin is told once with the reason", async () => {
  await world();
  const id = project("ci-fail", "ci");
  const release = holdSlot(id);
  fake.checkRuns[KEY(sha(12))] = [{ status: "completed", conclusion: "failure" }];
  await deliver("push", push(sha(12)));
  assert.equal(row(id).pending_deploy_sha, null, "not deployed");
  assert.equal(row(id).pending_ci_sha, null, "no longer held");
  assert.deepEqual(blocked(id), [`The checks for ${sha(12).slice(0, 7)} failed, so it was not deployed.`]);
  release();
});

test("a newer push replaces the held commit; only the matching commit is released by a check event", async () => {
  await world();
  const id = project("ci-replace", "ci");
  const release = holdSlot(id);
  fake.checkRuns[KEY(sha(13))] = [{ status: "in_progress", conclusion: null }];
  fake.checkRuns[KEY(sha(14))] = [{ status: "in_progress", conclusion: null }];
  await deliver("push", push(sha(13)));
  await deliver("push", push(sha(14)));
  assert.equal(row(id).pending_ci_sha, sha(14), "the newest push is the one waiting");
  fake.checkRuns[KEY(sha(13))] = [{ status: "completed", conclusion: "success" }];
  const stale = await deliver("check_suite", { action: "completed", installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" }, check_suite: { head_sha: sha(13), status: "completed", conclusion: "success" } });
  assert.match(stale ?? "", /ignored: No project is waiting/, "the old commit's checks do not release the new one");
  assert.equal(row(id).pending_ci_sha, sha(14));
  release();
});

test("a repository with no checks is held for a grace period, then deploys", async () => {
  await world();
  const id = project("ci-none", "ci");
  const release = holdSlot(id);
  holdForCi(id, sha(15), new Date());
  const early = await sweepHeldCommits(new Date(Date.now() + NO_CHECKS_GRACE_MS - 5_000), client);
  assert.deepEqual(early, ["held"]);
  assert.equal(row(id).pending_ci_sha, sha(15));
  const late = await sweepHeldCommits(new Date(Date.now() + NO_CHECKS_GRACE_MS + 5_000), client);
  assert.deepEqual(late, ["deployed"], "no checks after the grace period: nothing to wait for");
  assert.equal(row(id).pending_deploy_sha, sha(15));
  clearPendingAutoDeploy(id); release();
});

test("a commit whose checks never finish is dropped after six hours, and GitHub being unreachable leaves it held", async () => {
  await world();
  const id = project("ci-stuck", "ci");
  fake.checkRuns[KEY(sha(16))] = [{ status: "queued", conclusion: null }];
  holdForCi(id, sha(16), new Date());
  assert.deepEqual(await sweepHeldCommits(new Date(Date.now() + 60_000), client), ["held"]);
  const down = new GithubClient({ apiUrl: "http://127.0.0.1:1", webUrl: "http://127.0.0.1:1", timeoutMs: 300, sleep: async () => undefined });
  assert.deepEqual(await sweepHeldCommits(new Date(Date.now() + 60_000), down), ["held"], "an error is not a failure of the checks");
  assert.deepEqual(await sweepHeldCommits(new Date(Date.now() + MAX_HOLD_MS + 60_000), client), ["dropped"]);
  assert.equal(row(id).pending_ci_sha, null);
});

test("push mode is untouched, and a release project ignores pushes", async () => {
  await world();
  const pushMode = project("mode-push", "push");
  const releaseMode = project("mode-release", "release");
  const rel1 = holdSlot(pushMode);
  const rel2 = holdSlot(releaseMode);
  const result = await deliver("push", push(sha(17)));
  assert.match(result ?? "", /mode-push: deploy queued/);
  assert.match(result ?? "", /mode-release: deploys on a release, not on a push/);
  assert.equal(row(pushMode).pending_deploy_sha, sha(17));
  assert.equal(row(releaseMode).pending_deploy_sha, null);
  clearPendingAutoDeploy(pushMode); rel1(); rel2();
});

// ---- M3: deploy a release

test("a published release deploys the commit its tag points at, for projects that deploy on release", async () => {
  await world();
  const id = project("rel-ok", "release");
  const other = project("rel-push", "push");
  const rel = holdSlot(id);
  const relOther = holdSlot(other);
  fake.refs["acme/shop@v1.2.0"] = sha(20);
  const result = await deliver("release", { action: "published", installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" }, release: { tag_name: "v1.2.0", prerelease: false, draft: false } });
  assert.match(result ?? "", /processed: rel-ok: release v1\.2\.0 deploy queued/);
  assert.equal(row(id).pending_deploy_sha, sha(20), "the commit the tag resolves to, not the branch tip");
  assert.equal(row(other).pending_deploy_sha, null, "a project that deploys on push does not deploy on a release");
  clearPendingAutoDeploy(id); rel(); relOther();
});

test("drafts, prereleases, other actions, unknown and odd tags are not deployed, each with its reason", async () => {
  await world();
  const id = project("rel-ign", "release");
  const rel = holdSlot(id);
  fake.refs["acme/shop@v2"] = sha(21);
  const event = (action: string, tag: string, extra: Record<string, boolean> = {}) => deliver("release", { action, installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" }, release: { tag_name: tag, prerelease: false, draft: false, ...extra } });
  assert.match((await event("published", "v2", { prerelease: true })) ?? "", /ignored: A prerelease is not deployed/);
  assert.match((await event("published", "v2", { draft: true })) ?? "", /ignored: A draft is not deployed/);
  assert.match((await event("edited", "v2")) ?? "", /ignored: Release action "edited" is not used/);
  assert.match((await event("published", "no-such-tag")) ?? "", /ignored: Could not resolve no-such-tag/);
  assert.match((await event("published", "v2/../../evil")) ?? "", /ignored: The release's tag is not a name/);
  assert.equal(row(id).pending_deploy_sha, null);
  rel();
});

test("releases and check events from an unlinked installation or an ungranted repository are ignored", async () => {
  await world();
  const id = project("rel-gate", "release");
  const rel = holdSlot(id);
  fake.refs["acme/shop@v3"] = sha(22);
  const body = { action: "published", installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" }, release: { tag_name: "v3", prerelease: false, draft: false } };
  assert.match((await deliver("release", { ...body, repository: { id: 999, full_name: "acme/shop" } })) ?? "", /does not have access/);
  getDatabase().prepare("UPDATE github_app_installations SET status = 'suspended' WHERE installation_id = 11").run();
  assert.match((await deliver("release", body)) ?? "", /not linked/);
  assert.equal(row(id).pending_deploy_sha, null);
  rel();
});

test("deployRelease on its own: a paused or manual project is left alone", async () => {
  await world();
  const id = project("rel-paused", "release");
  getDatabase().prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(id);
  fake.refs["acme/shop@v4"] = sha(23);
  assert.match(await deployRelease(11, 101, "v4", false, false, client), /rel-paused: paused/);
  getDatabase().prepare("UPDATE projects SET paused = 0, deploy_trigger = 'manual' WHERE id = ?").run(id);
  assert.match(await deployRelease(11, 101, "v4", false, false, client), /deploys are manual/);
});

// ---- which modes an App can serve

test("a mode needs the module the App was registered with, and for CI the permissions to read checks", async () => {
  await world(["ci", "releases"]);
  assert.equal(modeAvailable("push", 11), null);
  assert.equal(modeAvailable("ci", 11), null);
  assert.equal(modeAvailable("release", 11), null);
  await world(["releases"]);
  assert.match(modeAvailable("ci", 11) ?? "", /without the CI module/);
  assert.equal(modeAvailable("release", 11), null);
  await world(["ci"], { contents: "read" });
  assert.match(modeAvailable("ci", 11) ?? "", /not approved the permissions/);
  assert.match(modeAvailable("release", 11) ?? "", /without the releases module/);
  assert.equal(await settleRepository(11, 101, null, new Date(), client).then((r) => r.length), 0);
});

// ---- choosing the mode

const put = (id: number, body: unknown): Promise<Response> =>
  fetch(`${base}/api/projects/${id}/github-deploy-on`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const modeOf = (id: number): string | null => (getDatabase().prepare("SELECT github_deploy_on AS m FROM projects WHERE id = ?").get(id) as { m: string | null }).m;

test("the mode is chosen per project, validated against the App, and refused for a project that does not use it", async () => {
  await world(["ci", "releases"]);
  const id = project("choose-mode", null);
  assert.equal((await fetch(`${base}/api/projects/${id}/github-deploy-on`, { method: "PUT" })).status, 401);
  assert.equal((await put(id, { mode: "weekly" })).status, 400);
  assert.equal((await put(id, { mode: "ci" })).status, 200);
  assert.equal(modeOf(id), "ci");
  assert.equal((await put(id, { mode: "release" })).status, 200);
  assert.equal((await put(id, { mode: "push" })).status, 200);
  assert.equal(modeOf(id), null, "push is the default and stored as nothing");
  const tokenProject = createProject({ name: "mode-token", sourceType: "github", githubRepo: "o/r" }).id;
  assert.equal((await put(tokenProject, { mode: "ci" })).status, 409);
  assert.equal((await put(999999, { mode: "ci" })).status, 404);

  await world(["releases"]);
  const noCi = project("no-ci-module", null);
  const refused = await put(noCi, { mode: "ci" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /without the CI module/);
  assert.equal(modeOf(noCi), null);
});

test("changing the mode, or moving back to a token, drops a commit that was waiting for checks", async () => {
  await world(["ci", "releases"]);
  const id = project("drop-held", "ci");
  holdForCi(id, sha(30));
  assert.equal(row(id).pending_ci_sha, sha(30));
  assert.equal((await put(id, { mode: "push" })).status, 200);
  assert.equal(row(id).pending_ci_sha, null);
  holdForCi(id, sha(31));
  unbindProjectFromApp(id);
  assert.equal(row(id).pending_ci_sha, null);
});
