import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { createProject } from "../src/modules/projects/operations";
import { actionRegistry, projectRepoKey } from "../src/modules/actions/registry";
import { clearPendingAutoDeploy } from "../src/modules/automation/autoDeploy";
import { getInstallation, replaceRepositories, saveApp, upsertInstallation } from "../src/modules/github/store";
import { listDeliveries, processDelivery, pruneDeliveries, receiveAppDelivery, reducePayload, replayDelivery, resumeDeliveries, verifyAppSignature } from "../src/modules/github/webhook";
import app from "../src/app";

const SECRET = "whsec-test";
let server: Server;
let base: string;
let token: string;
let counter = 0;

const sign = (body: string, secret = SECRET): string => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
const newId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function register(): void {
  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_deliveries", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
  // Projects from earlier tests would see every push and could start a real deploy.
  db.prepare("UPDATE projects SET github_auth_mode = NULL").run();
  saveApp({ appId: 1, slug: "s", name: "S", clientId: "c", ownerLogin: "acme", ownerType: "Organization", isPublic: false, htmlUrl: "https://github.test/apps/s", registeredOrigin: "https://sp.example.com", modules: [] },
    { privateKey: "pem", webhookSecret: SECRET, clientSecret: "cs" });
}

/** Installation 11 (linked) exposing repository 101 `acme/shop`; installation 22 (linked) exposing 201. */
function world(): void {
  register();
  upsertInstallation({ installationId: 11, accountId: 1, accountLogin: "acme", accountType: "Organization", permissions: {}, suspended: false }, true);
  upsertInstallation({ installationId: 22, accountId: 2, accountLogin: "bob", accountType: "User", permissions: {}, suspended: false }, true);
  replaceRepositories(11, [{ repositoryId: 101, installationId: 11, fullName: "acme/shop", defaultBranch: "main", isPrivate: false, archived: false }]);
  replaceRepositories(22, [{ repositoryId: 201, installationId: 22, fullName: "bob/api", defaultBranch: "main", isPrivate: false, archived: false }]);
}

function appProject(name: string, extra: Partial<{ branch: string | null; paused: boolean; trigger: string; installationId: number; repositoryId: number; lastSha: string | null }> = {}): number {
  const { id } = createProject({ name, sourceType: "github", githubRepo: "acme/shop" });
  getDatabase().prepare("UPDATE projects SET github_auth_mode = 'app', github_installation_id = ?, github_repository_id = ?, auto_deploy_branch = ?, paused = ?, deploy_trigger = ?, last_commit_sha = ? WHERE id = ?")
    .run(extra.installationId ?? 11, extra.repositoryId ?? 101, extra.branch === undefined ? "main" : extra.branch, extra.paused ? 1 : 0, extra.trigger ?? "poller", extra.lastSha ?? null, id);
  return id;
}

/** Occupies the project's slot so a deploy queues instead of starting a real one. */
function holdSlot(projectId: number): () => void {
  let release!: () => void;
  actionRegistry.tryStart(projectRepoKey(projectId), "build", { projectId }, () => new Promise((resolve) => { release = () => resolve({ ok: true, output: "" }); }));
  return release;
}

const pending = (projectId: number): string | null => (getDatabase().prepare("SELECT pending_deploy_sha FROM projects WHERE id = ?").get(projectId) as { pending_deploy_sha: string | null }).pending_deploy_sha;

function deliver(event: string, payload: unknown, options: { id?: string; secret?: string } = {}): { status: number; body: Record<string, unknown>; id: string } {
  const body = JSON.stringify(payload);
  const id = options.id ?? newId();
  const { result, deliveryId } = receiveAppDelivery(Buffer.from(body), { signature: sign(body, options.secret), deliveryId: id, event });
  if (deliveryId) processDelivery(deliveryId);
  return { ...result, id };
}

const push = (sha: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: "refs/heads/main", after: sha, deleted: false, installation: { id: 11 }, repository: { id: 101, full_name: "acme/shop" },
  head_commit: { message: "fix it\nmore", author: { name: "dev" }, timestamp: "2026-11-10T10:00:00Z" }, ...over,
});

const statusOf = (id: string): string => (getDatabase().prepare("SELECT status FROM github_app_deliveries WHERE delivery_id = ?").get(id) as { status: string }).status;
const detailOf = (id: string): string => (getDatabase().prepare("SELECT last_error FROM github_app_deliveries WHERE delivery_id = ?").get(id) as { last_error: string }).last_error;

before(async () => {
  initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = issueAuthToken("admin");
});
after(() => { server.close(); });

// ---- intake

test("a delivery with a wrong or missing signature is refused and stores nothing", () => {
  world();
  const body = JSON.stringify({ zen: "x" });
  for (const signature of [undefined, "", "sha256=", sign(body, "another-secret"), sign(body).replace("sha256=", "sha1=")]) {
    assert.equal(receiveAppDelivery(Buffer.from(body), { signature, deliveryId: newId(), event: "ping" }).result.status, 401, String(signature));
  }
  assert.equal(listDeliveries().length, 0);
  assert.equal(verifyAppSignature(SECRET, Buffer.from(body), sign(body)), true);
  assert.equal(verifyAppSignature(SECRET, Buffer.from(body), sign(body + " ")), false, "the signature is over the exact bytes");
});

test("a malformed delivery id or body is refused, and with no App registered the endpoint says so", () => {
  world();
  const body = JSON.stringify({ zen: "x" });
  assert.equal(receiveAppDelivery(Buffer.from(body), { signature: sign(body), deliveryId: "", event: "ping" }).result.status, 400);
  assert.equal(receiveAppDelivery(Buffer.from(body), { signature: sign(body), deliveryId: "../../etc", event: "ping" }).result.status, 400);
  const notJson = "not json";
  assert.equal(receiveAppDelivery(Buffer.from(notJson), { signature: sign(notJson), deliveryId: newId(), event: "ping" }).result.status, 400);
  getDatabase().prepare("DELETE FROM github_app").run();
  assert.equal(receiveAppDelivery(Buffer.from(body), { signature: sign(body), deliveryId: newId(), event: "ping" }).result.status, 404);
});

test("a valid delivery is stored before it is answered, and a ping is handled", () => {
  world();
  const body = JSON.stringify({ zen: "Keep it logically awesome" });
  const id = newId();
  const { result, deliveryId } = receiveAppDelivery(Buffer.from(body), { signature: sign(body), deliveryId: id, event: "ping" });
  assert.equal(result.status, 202);
  assert.equal(deliveryId, id);
  assert.equal(statusOf(id), "received", "on disk before any handling");
  processDelivery(id);
  assert.equal(statusOf(id), "processed");
});

test("the same delivery id is acknowledged but handled once", () => {
  world();
  const id = appProject("dedupe");
  const release = holdSlot(id);
  const delivery = newId();
  assert.equal(deliver("push", push("a".repeat(40)), { id: delivery }).status, 202);
  const second = deliver("push", push("a".repeat(40)), { id: delivery });
  assert.equal(second.status, 200);
  assert.equal(second.body["duplicate"], true);
  assert.equal(listDeliveries().filter((d) => d.deliveryId === delivery).length, 1);
  clearPendingAutoDeploy(id); release();
});

test("only the fields that are used are kept: a payload cannot make us store more", () => {
  world();
  const big = { ...push("b".repeat(40)), sender: { login: "x", token: "TOPSECRET-VALUE" }, commits: Array.from({ length: 5000 }, (_, i) => ({ id: i, message: "m".repeat(200) })), note: "N".repeat(500_000) };
  const stored = reducePayload("push", big);
  const json = JSON.stringify(stored);
  assert.ok(!json.includes("TOPSECRET") && !json.includes("NNNN"));
  assert.ok(json.length < 2000, `stored ${json.length} bytes`);
  assert.equal(stored.commit?.message, "fix it", "a commit message is reduced to its first line");
  const { id } = deliver("push", big);
  const row = getDatabase().prepare("SELECT payload_json FROM github_app_deliveries WHERE delivery_id = ?").get(id) as { payload_json: string };
  assert.ok(row.payload_json.length < 2000);
});

// ---- push

test("a push to the watched branch of a bound project queues a deploy, with the commit's details", () => {
  world();
  const projectId = appProject("push-ok");
  const release = holdSlot(projectId);
  const sha = "c".repeat(40);
  const { id } = deliver("push", push(sha));
  assert.equal(statusOf(id), "processed");
  assert.match(detailOf(id), /push-ok: deploy queued/);
  assert.equal(pending(projectId), sha);
  clearPendingAutoDeploy(projectId); release();
});

test("pushes that must not deploy are ignored, each with its reason", () => {
  world();
  const sha = "d".repeat(40);
  // Each case gets its own project, and is unbound afterwards: every project bound to the repository sees every push.
  const cases: [string, () => number, Record<string, unknown>, RegExp][] = [
    ["other branch", () => appProject("br"), push(sha, { ref: "refs/heads/feature" }), /not main/],
    ["paused", () => appProject("pa", { paused: true }), push(sha), /paused/],
    ["manual", () => appProject("ma", { trigger: "manual" }), push(sha), /manual/],
    ["no branch", () => appProject("nb", { branch: null }), push(sha), /no auto-deploy branch/],
    ["same commit", () => appProject("sc", { lastSha: sha }), push(sha), /already deployed/],
    ["deleted", () => appProject("de"), push(sha, { deleted: true }), /deleted/],
    ["zero sha", () => appProject("zs"), push("0".repeat(40)), /deleted/],
  ];
  for (const [label, make, payload, reason] of cases) {
    const projectId = make();
    const release = holdSlot(projectId);
    const { id } = deliver("push", payload);
    assert.equal(statusOf(id), "ignored", label);
    assert.match(detailOf(id), reason, label);
    assert.equal(pending(projectId), null, `${label}: nothing queued`);
    release();
    getDatabase().prepare("UPDATE projects SET github_auth_mode = NULL WHERE id = ?").run(projectId);
  }
});

test("a push is ignored when the installation is not linked, the repository is not granted, or the ids do not match", () => {
  world();
  const sha = "e".repeat(40);
  const projectId = appProject("gate");
  const release = holdSlot(projectId);

  // Another installation claiming this repository: the bound installation is 11, so nothing matches.
  const spoof = deliver("push", push(sha, { installation: { id: 22 } }));
  assert.equal(statusOf(spoof.id), "ignored");
  assert.match(detailOf(spoof.id), /does not have access|No project/);
  assert.equal(pending(projectId), null);

  // A repository id that is not ours, even with a matching name.
  const wrongRepo = deliver("push", push(sha, { repository: { id: 999, full_name: "acme/shop" } }));
  assert.equal(statusOf(wrongRepo.id), "ignored");
  assert.equal(pending(projectId), null);

  getDatabase().prepare("UPDATE github_app_repositories SET access_status = 'revoked' WHERE repository_id = 101").run();
  const revoked = deliver("push", push(sha));
  assert.match(detailOf(revoked.id), /does not have access/);
  getDatabase().prepare("UPDATE github_app_repositories SET access_status = 'granted' WHERE repository_id = 101").run();

  getDatabase().prepare("UPDATE github_app_installations SET status = 'unlinked' WHERE installation_id = 11").run();
  const unlinked = deliver("push", push(sha));
  assert.match(detailOf(unlinked.id), /not linked/);
  assert.equal(pending(projectId), null);
  release();
});

test("two projects on the same repository both deploy, and a project on a token is never touched", () => {
  world();
  const a = appProject("twin-a");
  const b = appProject("twin-b");
  const { id: tokenProject } = createProject({ name: "token-twin", sourceType: "github", githubRepo: "acme/shop" });
  getDatabase().prepare("UPDATE projects SET auto_deploy_branch = 'main' WHERE id = ?").run(tokenProject);
  const releases = [holdSlot(a), holdSlot(b), holdSlot(tokenProject)];
  const sha = "f".repeat(40);
  deliver("push", push(sha));
  assert.equal(pending(a), sha);
  assert.equal(pending(b), sha);
  assert.equal(pending(tokenProject), null, "a project that does not use the App is not deployed by the App's webhook");
  for (const id of [a, b]) clearPendingAutoDeploy(id);
  releases.forEach((r) => r());
});

test("out of order and repeated pushes coalesce to the newest commit", () => {
  world();
  const projectId = appProject("coalesce");
  const release = holdSlot(projectId);
  deliver("push", push("1".repeat(40)));
  deliver("push", push("2".repeat(40)));
  deliver("push", push("1".repeat(40)));
  assert.equal(pending(projectId), "1".repeat(40), "the last one handled is the one waiting; one deploy follows, not three");
  clearPendingAutoDeploy(projectId); release();
});

// ---- installation events

test("a new installation is recorded unlinked: its pushes are ignored until its owner is proved", () => {
  world();
  const created = deliver("installation", { action: "created", installation: { id: 33, account: { id: 3, login: "mallory", type: "User" }, permissions: { contents: "read" } } });
  assert.equal(statusOf(created.id), "processed");
  assert.equal(getInstallation(33)?.status, "unlinked");
  getDatabase().prepare("UPDATE projects SET github_installation_id = 33 WHERE id = ?").run(appProject("unlinked-push"));
  const pushed = deliver("push", push("a1".repeat(20), { installation: { id: 33 } }));
  assert.equal(statusOf(pushed.id), "ignored");
  assert.match(detailOf(pushed.id), /not linked/);
});

test("suspend, unsuspend and delete change the installation but never touch a project or what it runs", () => {
  world();
  const projectId = appProject("keeps-running");
  const event = (action: string) => deliver("installation", { action, installation: { id: 11, account: { id: 1, login: "acme", type: "Organization" } } });
  event("suspend");
  assert.equal(getInstallation(11)?.status, "suspended");
  event("unsuspend");
  assert.equal(getInstallation(11)?.status, "linked", "back to linked: it was proved before");
  event("deleted");
  assert.equal(getInstallation(11)?.status, "removed");
  const project = getDatabase().prepare("SELECT github_auth_mode, github_installation_id FROM projects WHERE id = ?").get(projectId) as { github_auth_mode: string; github_installation_id: number };
  assert.deepEqual([project.github_auth_mode, project.github_installation_id], ["app", 11], "the binding is left for the admin to move; nothing was removed");
  const unknown = deliver("installation", { action: "suspend", installation: { id: 4040 } });
  assert.equal(statusOf(unknown.id), "ignored");
  assert.equal(getInstallation(4040), null);
});

test("an unsuspend never links an installation that was never proved", () => {
  world();
  deliver("installation", { action: "created", installation: { id: 55, account: { id: 5, login: "eve", type: "User" } } });
  deliver("installation", { action: "suspend", installation: { id: 55 } });
  deliver("installation", { action: "unsuspend", installation: { id: 55 } });
  assert.equal(getInstallation(55)?.status, "unlinked");
});

test("repositories added or removed update the cache, and a removed one is revoked, not deleted", () => {
  world();
  const added = deliver("installation_repositories", { action: "added", installation: { id: 11 }, repositories_added: [{ id: 102, full_name: "acme/blog", private: true }], repositories_removed: [] });
  assert.equal(statusOf(added.id), "processed");
  assert.equal(getInstallation(11)?.repositoryCount, 2);
  deliver("installation_repositories", { action: "removed", installation: { id: 11 }, repositories_added: [], repositories_removed: [{ id: 101, full_name: "acme/shop" }] });
  const row = getDatabase().prepare("SELECT access_status FROM github_app_repositories WHERE repository_id = 101").get() as { access_status: string };
  assert.equal(row.access_status, "revoked");

  upsertInstallation({ installationId: 66, accountId: 6, accountLogin: "zed", accountType: "User", permissions: {}, suspended: false }, false);
  deliver("installation_repositories", { action: "added", installation: { id: 66 }, repositories_added: [{ id: 601, full_name: "zed/x" }], repositories_removed: [] });
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM github_app_repositories WHERE installation_id = 66").get() as { n: number }).n, 0, "an unlinked installation's repositories are not made usable");
});

test("events we do not use yet are recorded and ignored", () => {
  world();
  const { id } = deliver("workflow_run", { action: "completed", installation: { id: 11 } });
  assert.equal(statusOf(id), "ignored");
  assert.match(detailOf(id), /not used yet/);
});

// ---- crash, failure, replay, retention

test("a delivery stored but not handled before a crash is handled at start-up", () => {
  world();
  const projectId = appProject("crash");
  const release = holdSlot(projectId);
  const body = JSON.stringify(push("9".repeat(40)));
  const id = newId();
  receiveAppDelivery(Buffer.from(body), { signature: sign(body), deliveryId: id, event: "push" });
  assert.equal(statusOf(id), "received");
  assert.equal(pending(projectId), null, "not handled yet: Stackport went down here");
  assert.equal(resumeDeliveries(), 1);
  assert.equal(statusOf(id), "processed");
  assert.equal(pending(projectId), "9".repeat(40));
  assert.equal(resumeDeliveries(), 0, "and not again");
  clearPendingAutoDeploy(projectId); release();
});

test("a delivery that fails is recorded, retried up to three times, and can be replayed by hand", () => {
  world();
  const id = newId();
  getDatabase().prepare("INSERT INTO github_app_deliveries (delivery_id, event, payload_json, status) VALUES (?, 'push', '{broken', 'received')").run(id);
  assert.equal(processDelivery(id), "failed");
  assert.equal(statusOf(id), "failed");
  assert.ok(detailOf(id).length > 0);
  assert.equal(resumeDeliveries(), 1);
  assert.equal(resumeDeliveries(), 1);
  assert.equal(resumeDeliveries(), 0, "after three attempts it is left for a person");
  getDatabase().prepare("UPDATE github_app_deliveries SET payload_json = ? WHERE delivery_id = ?").run(JSON.stringify(reducePayload("ping", {})), id);
  getDatabase().prepare("UPDATE github_app_deliveries SET event = 'ping' WHERE delivery_id = ?").run(id);
  assert.equal(replayDelivery(id), "processed", "replayed once whatever was wrong is fixed");
  assert.equal(replayDelivery("does-not-exist"), null);
});

test("retention: handled deliveries go after 14 days, failed ones after 30", () => {
  world();
  const db = getDatabase();
  const insert = (id: string, status: string, daysAgo: number) => db.prepare("INSERT INTO github_app_deliveries (delivery_id, event, payload_json, status, received_at) VALUES (?, 'ping', '{}', ?, datetime('now', ?))").run(id, status, `-${daysAgo} days`);
  insert("keep-fresh-0001", "processed", 3);
  insert("drop-old-ok-001", "processed", 15);
  insert("drop-old-ign-01", "ignored", 20);
  insert("keep-failed-001", "failed", 20);
  insert("drop-failed-001", "failed", 31);
  assert.equal(pruneDeliveries(), 3);
  assert.deepEqual(listDeliveries(10).map((d) => d.deliveryId).sort(), ["keep-failed-001", "keep-fresh-0001"]);
});

// ---- over HTTP

test("the endpoint is reachable at /api/hooks/github/app (not mistaken for a project), answers only after storing, and needs no login", async () => {
  world();
  const body = JSON.stringify({ zen: "http" });
  const bad = await fetch(`${base}/api/hooks/github/app`, { method: "POST", headers: { "x-hub-signature-256": sign(body, "wrong"), "x-github-delivery": newId(), "x-github-event": "ping", "content-type": "application/json" }, body });
  assert.equal(bad.status, 401);
  const id = newId();
  const good = await fetch(`${base}/api/hooks/github/app`, { method: "POST", headers: { "x-hub-signature-256": sign(body), "x-github-delivery": id, "x-github-event": "ping", "content-type": "application/json" }, body });
  assert.equal(good.status, 202);
  assert.ok(listDeliveries().some((d) => d.deliveryId === id), "stored by the time it was answered");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(statusOf(id), "processed");
});

test("the delivery log and replay need a login", async () => {
  world();
  assert.equal((await fetch(`${base}/api/github-app/deliveries`)).status, 401);
  assert.equal((await fetch(`${base}/api/github-app/deliveries/x/replay`, { method: "POST" })).status, 401);
  const id = deliver("ping", { zen: "x" }).id;
  const list = await fetch(`${base}/api/github-app/deliveries`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(list.status, 200);
  assert.ok(((await list.json()) as { deliveries: { deliveryId: string }[] }).deliveries.some((d) => d.deliveryId === id));
  const replay = await fetch(`${base}/api/github-app/deliveries/${id}/replay`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(replay.status, 200);
  assert.equal((await fetch(`${base}/api/github-app/deliveries/nope/replay`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status, 404);
});
