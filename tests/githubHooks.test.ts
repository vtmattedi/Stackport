import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { encryptSecret } from "../src/utils/crypto";
import { createProject } from "../src/services/projectAdmin";
import { actionRegistry, projectRepoKey } from "../src/services/actionRegistry";
import app from "../src/app";

const SECRET = "hook-secret";
const HOOK_ID = "a".repeat(32);
let server: Server;
let base: string;
let projectId: number;
let releaseSlot: () => void;

function sign(body: string, secret = SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

let deliveryCounter = 0;
async function deliver(payload: unknown, opts: { event?: string; signature?: string | null; deliveryId?: string } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event ?? "push",
    "x-github-delivery": opts.deliveryId ?? `delivery-${++deliveryCounter}`,
  };
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  const res = await fetch(`${base}/api/hooks/github/${HOOK_ID}`, { method: "POST", headers, body });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

function push(sha: string, overrides: Record<string, unknown> = {}) {
  return { ref: "refs/heads/main", after: sha, repository: { full_name: "owner/repo" }, head_commit: { message: "msg" }, ...overrides };
}

before(async () => {
  initializeDatabase();
  projectId = createProject({ name: "hooked", sourceType: "github", githubRepo: "owner/repo" }).id;
  getDatabase().prepare(
    "UPDATE projects SET github_repo = 'owner/repo', auto_deploy_branch = 'main', deploy_trigger = 'webhook', hook_public_id = ?, hook_secret_enc = ? WHERE id = ?"
  ).run(HOOK_ID, encryptSecret(SECRET), projectId);
  // Hold the project's action slot so an accepted push queues instead of running a real deploy.
  actionRegistry.tryStart(projectRepoKey(projectId), "build", { projectId }, () => new Promise((resolve) => {
    releaseSlot = () => resolve({ ok: true, output: "" });
  }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  // Pause first so releasing the slot doesn't start the queued deploy.
  getDatabase().prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(projectId);
  releaseSlot();
  server.close();
});

test("unknown hook ids are 404", async () => {
  const res = await fetch(`${base}/api/hooks/github/${"b".repeat(32)}`, { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
});

test("missing or wrong signatures are rejected", async () => {
  assert.equal((await deliver(push("1".repeat(40)), { signature: null })).status, 401);
  assert.equal((await deliver(push("1".repeat(40)), { signature: sign("{}", "other") })).status, 401);
});

test("ping verifies the hook", async () => {
  const res = await deliver({ zen: "hi" }, { event: "ping" });
  assert.equal(res.status, 200);
  const row = getDatabase().prepare("SELECT hook_status FROM projects WHERE id = ?").get(projectId) as { hook_status: string };
  assert.equal(row.hook_status, "verified");
});

test("pushes to other branches or repos are ignored", async () => {
  assert.equal((await deliver(push("2".repeat(40), { ref: "refs/heads/dev" }))).json["ignored"], true);
  assert.equal((await deliver(push("2".repeat(40), { repository: { full_name: "someone/else" } }))).json["ignored"], true);
  assert.equal((await deliver(push("0".repeat(40), { deleted: true }))).json["ignored"], true);
});

test("a push to the auto-deploy branch queues behind the running action", async () => {
  const sha = "3".repeat(40);
  const res = await deliver(push(sha));
  assert.equal(res.status, 202);
  assert.equal(res.json["outcome"], "queued");
  const row = getDatabase().prepare("SELECT pending_deploy_sha, last_commit_sha FROM projects WHERE id = ?").get(projectId) as { pending_deploy_sha: string; last_commit_sha: string | null };
  assert.equal(row.pending_deploy_sha, sha);
  assert.notEqual(row.last_commit_sha, sha, "a queued commit must not count as deployed");
});

test("a redelivered delivery id is acknowledged once", async () => {
  const first = await deliver(push("4".repeat(40)), { deliveryId: "same-id" });
  const again = await deliver(push("4".repeat(40)), { deliveryId: "same-id" });
  assert.equal(first.status, 202);
  assert.equal(again.json["duplicate"], true);
});

test("payloads larger than the app-wide JSON limit still arrive", async () => {
  const res = await deliver(push("5".repeat(40), { commits: [{ message: "x".repeat(40_000) }] }));
  assert.equal(res.status, 202);
});

test("the poller covers webhook projects whose hook is failing, at the normal interval", async () => {
  const { selectProjectsToPoll } = await import("../src/services/githubPoller");
  const db = getDatabase();
  const make = (name: string, trigger: string, hookStatus: string | null, checkedMinutesAgo: number | null) => {
    const { id } = createProject({ name, sourceType: "github", githubRepo: `o/${name}` });
    db.prepare("UPDATE projects SET deploy_trigger = ?, hook_status = ?, github_checked_at = ? WHERE id = ?").run(
      trigger, hookStatus, checkedMinutesAgo === null ? null : new Date(Date.now() - checkedMinutesAgo * 60_000).toISOString(), id,
    );
    return id;
  };
  const poller = make("sel-poller", "poller", null, 1);
  const healthy = make("sel-healthy", "webhook", "verified", 5);
  const stale = make("sel-stale", "webhook", "verified", 45);
  const failing = make("sel-failing", "webhook", "failing", 1);
  const manual = make("sel-manual", "manual", null, null);

  const ids = (on: boolean) => new Set(selectProjectsToPoll(on).map((r) => r.id));
  const withSafety = ids(true);
  assert.ok(withSafety.has(poller));
  assert.ok(!withSafety.has(healthy), "a working hook checked recently is left alone");
  assert.ok(withSafety.has(stale), "the 30-minute safety check");
  assert.ok(withSafety.has(failing), "a failing hook is polled every time");
  assert.ok(!withSafety.has(manual));

  const withoutSafety = ids(false);
  assert.ok(withoutSafety.has(poller));
  assert.ok(!withoutSafety.has(failing) && !withoutSafety.has(stale), "turning the safety check off means webhook projects aren't polled");
});
