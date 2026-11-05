import { beforeEach, afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { enqueuePushEvent, PUSH_LEASE_MS } from "../src/services/pushOutbox";
import { PushDeliveryWorker, nextPushAttemptAt } from "../src/services/pushDeliveryWorker";
import { classifyPushFailure, getPushConfig, sendOnePush, updatePushConfig } from "../src/services/webPush";
import webpush from "web-push";
import type { DurablePushEvent } from "../src/services/notificationTypes";
import Database from "better-sqlite3";
import { config } from "../src/config/env";

const initial = Date.parse("2026-11-03T20:00:00Z");
let now = initial;
function browser(name = "one"): number {
  return Number(getDatabase().prepare("INSERT INTO push_subscriptions (endpoint,p256dh,auth,label) VALUES (?, 'public','auth',?)")
    .run(`https://fcm.googleapis.com/${name}`, name).lastInsertRowid);
}
function enqueue(key = "deploy_unhealthy:1:one"): void {
  const event: DurablePushEvent = { eventKey: key, type: "deploy_unhealthy", severity: "error", title: "Unhealthy",
    body: "Open Stackport for details.", url: "/projects/1", createdAt: new Date(initial).toISOString() };
  enqueuePushEvent(getDatabase(), event, initial);
}
function rows(): { status: string; attempts: number; next_attempt_at_ms: number; last_error_code: string }[] {
  return getDatabase().prepare("SELECT * FROM push_deliveries ORDER BY id").all() as ReturnType<typeof rows>;
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  initializeDatabase(); now = initial;
  getDatabase().exec("DELETE FROM push_deliveries; DELETE FROM push_events; DELETE FROM push_subscriptions; DELETE FROM push_config");
  updatePushConfig({ enabled: true, subject: "operator@example.com" });
});
afterEach(() => mock.restoreAll());

test("503 retries durably, honors Retry-After and reaches accepted after DB reopen", async () => {
  browser(); enqueue();
  let calls = 0;
  const worker = new PushDeliveryWorker({ now: () => now, random: () => 0.5, send: async () => {
    calls++; return calls === 1 ? classifyPushFailure({ statusCode: 503, headers: { "retry-after": "60" } }, now) : { kind: "accepted", httpStatus: 201 };
  } });
  await worker.poll();
  assert.equal(rows()[0].status, "retry");
  assert.equal(rows()[0].next_attempt_at_ms, initial + 60_000);
  closeDatabase(); initializeDatabase();
  now += 59_999; await worker.poll(); assert.equal(calls, 1);
  now++; await worker.poll();
  assert.equal(rows()[0].status, "accepted"); assert.equal(calls, 2);
});

test("response classification preserves legitimate subscriptions on authentication and transient failures", () => {
  for (const statusCode of [408, 429, 500, 502, 503]) assert.equal(classifyPushFailure({ statusCode }).kind, "retry");
  for (const statusCode of [401, 403, 400, 413]) assert.equal(classifyPushFailure({ statusCode }).kind, "permanent_failure");
  for (const statusCode of [404, 410]) assert.equal(classifyPushFailure({ statusCode }).kind, "expired");
  assert.equal(classifyPushFailure(new Error("SECRET_URL")).code, "push_network_error");
  assert.equal(classifyPushFailure({ statusCode: 429, headers: { "retry-after": new Date(initial + 120_000).toUTCString() } }, initial).retryAfterAt, initial + 120_000);
  assert.equal(classifyPushFailure({ statusCode: 503, headers: { "retry-after": "invalid" } }, initial).retryAfterAt, undefined);
  assert.equal(nextPushAttemptAt(1, initial, initial + 10_000, 0.5, initial + 999_999), initial + 10_000);
});

test("provider timeout retries with remaining lifetime TTL, without deleting browser", async () => {
  const id = browser(); enqueue(); now += 3_600_000;
  let ttl = 0;
  const worker = new PushDeliveryWorker({ now: () => now, send: async (_id, _payload, seconds) => { ttl = seconds; throw new Error("timeout"); } });
  await worker.poll();
  assert.equal(ttl, 11 * 3600);
  assert.equal(rows()[0].status, "retry");
  assert.ok(getDatabase().prepare("SELECT id FROM push_subscriptions WHERE id=?").get(id));
});

test("one broken browser is independent and parallel requests never exceed four", async () => {
  for (let index = 0; index < 10; index++) browser(String(index));
  enqueue();
  let active = 0; let peak = 0;
  const releases: (() => void)[] = [];
  const worker = new PushDeliveryWorker({ now: () => now, send: async (id) => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return id % 2 ? { kind: "accepted" } : { kind: "retry", code: "push_network_error" };
  } });
  const running = worker.poll();
  for (let wave = 0; wave < 3; wave++) { await settle(); releases.splice(0).forEach((resolve) => resolve()); }
  await running;
  assert.equal(peak, 4);
  assert.equal(rows().filter((row) => row.status === "accepted").length, 5);
  assert.equal(rows().filter((row) => row.status === "retry").length, 5);
});

test("expired events make no provider request; old leases resume after a process dies", async () => {
  browser(); enqueue();
  let calls = 0;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => { calls++; return { kind: "accepted" }; } });
  now += 13 * 3_600_000; await worker.poll();
  assert.equal(calls, 0); assert.equal(rows()[0].status, "expired");
});

test("a finalization failure cannot release the poll lock while other sends remain active", async () => {
  for (let index = 0; index < 12; index++) browser(String(index));
  enqueue();
  const db = getDatabase();
  db.exec("CREATE TEMP TRIGGER finalize_fail BEFORE UPDATE OF status ON push_deliveries WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'write failed'); END");
  const releases: (() => void)[] = [];
  let calls = 0; let active = 0; let peak = 0;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--; return { kind: "accepted" };
  } });
  try {
    const first = worker.poll(); let settled = false;
    void first.then(() => { settled = true; });
    await settle(); assert.equal(calls, 4);
    releases.shift()!(); await settle();
    assert.equal(settled, false);
    assert.equal(worker.poll(), first, "a second poll shares the active batch even after a write failure");
    assert.equal(calls, 4);
    db.exec("DROP TRIGGER finalize_fail");
    for (let wave = 0; wave < 3; wave++) { releases.splice(0).forEach((resolve) => resolve()); await settle(); }
    await first;
    assert.equal(peak, 4);
    assert.equal(rows().filter((row) => row.status === "accepted").length, 11);
    assert.equal(rows().filter((row) => row.status === "leased").length, 1, "failed finalization recovers through its existing lease");
  } finally { db.exec("DROP TRIGGER IF EXISTS finalize_fail"); }
});

test("shutdown leaves unstarted deliveries pending for immediate restart without consuming attempts", async () => {
  for (let index = 0; index < 16; index++) browser(String(index));
  enqueue();
  const releases: (() => void)[] = [];
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => {
    await new Promise<void>((resolve) => releases.push(resolve)); return { kind: "accepted" };
  } });
  const running = worker.poll(); await settle();
  await worker.stop(1);
  assert.equal(rows().filter((row) => row.status === "leased").length, 4);
  assert.equal(rows().filter((row) => row.status === "pending" && row.attempts === 0).length, 12);
  releases.splice(0).forEach((resolve) => resolve()); await running;
  closeDatabase(); initializeDatabase();
  await new PushDeliveryWorker({ now: () => now, send: async () => ({ kind: "accepted" }) }).poll();
  assert.equal(rows().filter((row) => row.status === "accepted").length, 12);
  assert.equal(rows().filter((row) => row.status === "leased").length, 4, "only in-flight sends retain lease protection");
});

test("disable during an HTTP request cannot resurrect the cancelled lease", async () => {
  browser(); enqueue();
  let finish!: () => void;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => {
    await new Promise<void>((resolve) => { finish = resolve; }); return { kind: "accepted" };
  } });
  const running = worker.poll(); await settle();
  updatePushConfig({ enabled: false }); finish(); await running;
  assert.equal(rows()[0].status, "cancelled");
});

test("bounded shutdown leaves unfinished work leased and recoverable, without accessing a closed DB", async () => {
  browser(); enqueue();
  let finish!: () => void;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => {
    await new Promise<void>((resolve) => { finish = resolve; }); return { kind: "accepted" };
  } });
  const running = worker.poll(); await settle(); await worker.stop(1);
  closeDatabase(); finish(); await running;
  initializeDatabase(); assert.equal(rows()[0].status, "leased");
  now += PUSH_LEASE_MS + 1;
  await new PushDeliveryWorker({ now: () => now, send: async () => ({ kind: "accepted" }) }).poll();
  assert.equal(rows()[0].status, "accepted");
});

test("expired browser is pruned and its other unsent work is cancelled while audit survives", async () => {
  browser(); for (let n = 0; n < 20; n++) enqueue(`deploy_unhealthy:1:${n}`);
  await new PushDeliveryWorker({ now: () => now, send: async () => ({ kind: "expired", httpStatus: 410, code: "subscription_expired" }) }).poll();
  assert.equal(getDatabase().prepare("SELECT id FROM push_subscriptions").get(), undefined);
  assert.ok(rows().some((row) => row.status === "expired"));
  assert.ok(rows().every((row) => ["expired", "cancelled"].includes(row.status)));
});

test("expired browser cleanup stays in the worker's injected database", async () => {
  const id = browser(); enqueue();
  const filename = `${config.sqlitePath}.worker`;
  await getDatabase().backup(filename);
  const isolated = new Database(filename);
  isolated.pragma("foreign_keys = ON");
  try {
    await new PushDeliveryWorker({ db: () => isolated, now: () => now, send: async () => ({ kind: "expired", httpStatus: 410 }) }).poll();
    assert.equal(isolated.prepare("SELECT id FROM push_subscriptions WHERE id=?").get(id), undefined);
    assert.ok(getDatabase().prepare("SELECT id FROM push_subscriptions WHERE id=?").get(id));
    assert.equal(rows()[0].status, "pending", "the global database is untouched by the isolated worker");
    assert.equal((isolated.prepare("SELECT status FROM push_deliveries").get() as { status: string }).status, "expired");
  } finally { isolated.close(); }
});

test("unreadable VAPID identity is diagnosed without rotation or network calls", async () => {
  const id = browser(); const publicKey = getPushConfig().vapidPublicKey;
  const saved = (getDatabase().prepare("SELECT vapid_private_key_enc FROM push_config").get() as { vapid_private_key_enc: string }).vapid_private_key_enc;
  enqueue();
  getDatabase().prepare("UPDATE push_deliveries SET attempts=11").run();
  getDatabase().prepare("UPDATE push_config SET vapid_private_key_enc='wrong-secret'").run();
  const send = mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, headers: {}, body: "" }));
  assert.match(getPushConfig().identityError ?? "", /matching database and host secrets/);
  assert.equal((await sendOnePush(id, "{}", 60)).code, "push_identity_unavailable");
  const worker = new PushDeliveryWorker({ now: () => now });
  for (let attempt = 0; attempt < 15; attempt++) {
    await worker.poll();
    assert.equal(rows()[0].status, "retry");
    assert.equal(rows()[0].attempts, 11, "configuration checks never consume the remaining provider attempt");
    now = rows()[0].next_attempt_at_ms;
  }
  assert.equal(send.mock.calls.length, 0);
  closeDatabase(); initializeDatabase();
  getDatabase().prepare("UPDATE push_config SET vapid_private_key_enc=?").run(saved);
  await new PushDeliveryWorker({ now: () => now }).poll();
  assert.equal(rows()[0].status, "accepted");
  assert.equal(rows()[0].attempts, 12);
  assert.equal(send.mock.calls.length, 1);
  assert.equal(getPushConfig().vapidPublicKey, publicKey);
});

test("configuration-blocked deliveries expire without sending after identity repair", async () => {
  browser(); enqueue();
  let blocked = true; let calls = 0;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => {
    calls++; return blocked ? { kind: "configuration_blocked", code: "push_identity_unavailable" } : { kind: "accepted" };
  } });
  await worker.poll();
  assert.equal(rows()[0].attempts, 0);
  closeDatabase(); initializeDatabase();
  now += 13 * 3_600_000; blocked = false;
  await worker.poll();
  assert.equal(rows()[0].status, "expired");
  assert.equal(calls, 1);
});

test("cancellation during an identity check cannot resurrect or refund a cancelled delivery", async () => {
  browser(); enqueue();
  let release!: () => void;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { kind: "configuration_blocked", code: "push_identity_unavailable" };
  } });
  const running = worker.poll(); await settle();
  updatePushConfig({ enabled: false }); release(); await running;
  assert.equal(rows()[0].status, "cancelled");
  assert.equal(rows()[0].attempts, 1);
});

test("retry budget is bounded and schedules use integer UTC milliseconds", async () => {
  browser(); enqueue();
  getDatabase().prepare("UPDATE push_deliveries SET attempts=11").run();
  let calls = 0;
  const worker = new PushDeliveryWorker({ now: () => now, send: async () => { calls++; return { kind: "retry", code: "push_network_error" }; } });
  await worker.poll(); now += 100_000; await worker.poll();
  assert.equal(calls, 1);
  assert.equal(rows()[0].status, "permanent_failure");
  assert.equal(rows()[0].last_error_code, "retry_limit");
  assert.ok(Number.isInteger(nextPushAttemptAt(1, initial, initial + 3_600_000, 0.123456789)));
});
