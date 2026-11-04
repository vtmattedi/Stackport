import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import webpush from "web-push";
import app from "../src/app";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { decryptSecret, encryptSecret } from "../src/utils/crypto";
import { issueAuthToken } from "../src/services/authTokens";
import { deletePushSubscription, getPushConfig, listPushSubscriptions, savePushSubscription, sendWebPushNotification, updatePushConfig } from "../src/services/webPush";
import { dispatchNotification, notifyDeployBlocked, notifyDeployUnhealthy, notifyHealthCheckFailure } from "../src/services/notificationService";
import { notifySelfUpdateOutcome } from "../src/services/selfUpdate";
import type { StackportNotification } from "../src/services/notificationTypes";
import { PushDeliveryWorker } from "../src/services/pushDeliveryWorker";

let server: Server;
let base: string;
let token: string;
before(async () => {
  initializeDatabase();
  token = issueAuthToken("admin");
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notifications/push`;
});
after(() => { server.close(); });
beforeEach(() => {
  initializeDatabase();
  getDatabase().exec("DELETE FROM push_deliveries; DELETE FROM push_events; DELETE FROM push_subscriptions; DELETE FROM push_config; DELETE FROM notification_logs; DELETE FROM notification_config; DELETE FROM app_meta WHERE key IN ('notified_self_update_id', 'enqueued_self_update_outcome')");
});
afterEach(() => { mock.restoreAll(); });

function subscription(suffix = "one") {
  const ec = createECDH("prime256v1");
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: {
    p256dh: ec.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  }, label: `Browser ${suffix}` };
}
const event = (): StackportNotification => ({ type: "health_check", severity: "error", title: "App is unhealthy",
  body: "Open Stackport for details.", projectId: 7, url: "/projects/7", createdAt: new Date().toISOString() });
function enablePush(): void { updatePushConfig({ enabled: true, subject: "operator@example.com" }); }
const sent = () => mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
async function api(route: string, method = "GET", body?: unknown, authenticated = true): Promise<Response> {
  return fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }) });
}

test("every push API requires an admin session", async () => {
  for (const [path, method] of [["/config", "GET"], ["/config", "PUT"], ["/subscriptions", "GET"],
    ["/subscriptions", "POST"], ["/subscriptions/1", "DELETE"], ["/test", "POST"], ["/status", "GET"], ["/subscriptions/resolve", "POST"]]) {
    assert.equal((await api(path, method, {}, false)).status, 401);
  }
});

test("identity is generated once, encrypted, preserved across restart and never returned by the API", async () => {
  const first = getPushConfig();
  const row = getDatabase().prepare("SELECT vapid_private_key_enc FROM push_config").get() as { vapid_private_key_enc: string };
  const privateKey = decryptSecret(row.vapid_private_key_enc);
  assert.notEqual(row.vapid_private_key_enc, privateKey);
  const ec = createECDH("prime256v1");
  ec.setPrivateKey(Buffer.from(privateKey, "base64url"));
  assert.equal(ec.getPublicKey().toString("base64url"), first.vapidPublicKey);
  closeDatabase(); initializeDatabase();
  assert.equal(getPushConfig().vapidPublicKey, first.vapidPublicKey);
  const response = await api("/config");
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes(privateKey) && !body.includes(row.vapid_private_key_enc));
  assert.equal(JSON.parse(body).enabled, false);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("all push settings are editable through the UI API with validated contact and event preferences", async () => {
  assert.equal((await api("/config", "PUT", { enabled: true })).status, 400);
  assert.equal((await api("/config", "PUT", { enabled: "yes", subject: "a@example.com" })).status, 400);
  assert.equal((await api("/config", "PUT", { enabled: true, subject: "javascript:alert(1)" })).status, 400);
  assert.equal((await api("/config", "PUT", { events: { made_up_event: true } })).status, 400);
  const response = await api("/config", "PUT", { enabled: true, subject: "operator@example.com", events: { health_check: false } });
  assert.equal(response.status, 200);
  const saved = await response.json() as ReturnType<typeof getPushConfig>;
  assert.equal(saved.subject, "mailto:operator@example.com");
  assert.equal(saved.events.health_check, false);
  assert.equal(saved.events.deploy_blocked, true);
  assert.equal(getPushConfig().enabled, true);
});

test("subscription creation/upsert, listing and deletion expose only safe metadata", async () => {
  const input = subscription();
  const response = await api("/subscriptions", "POST", input);
  assert.equal(response.status, 201);
  const first = await response.json() as { id: number };
  const updated = await (await api("/subscriptions", "POST", { ...input, label: "Work laptop" })).json() as { id: number };
  assert.equal(updated.id, first.id);
  const text = await (await api("/subscriptions")).text();
  assert.equal(JSON.parse(text).length, 1);
  for (const secret of [input.endpoint, input.keys.p256dh, input.keys.auth]) assert.ok(!text.includes(secret));
  assert.match(text, /Work laptop/);
  assert.equal((await api(`/subscriptions/${first.id}`, "DELETE")).status, 200);
  assert.equal(listPushSubscriptions().length, 0);
  assert.equal(deletePushSubscription(first.id), false);
});

test("invalid keys, insecure endpoints and internal/arbitrary targets are rejected", async () => {
  const input = subscription();
  assert.throws(() => savePushSubscription(null), /Invalid browser subscription/);
  for (const invalid of [[], {}, { ...input, keys: { ...input.keys, auth: "wrong" } },
    { ...input, keys: { ...input.keys, p256dh: Buffer.alloc(65).toString("base64url") } },
    ...["http://fcm.googleapis.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://example.com/x",
      "https://fcm.googleapis.com.attacker.test/x", "https://user:password@fcm.googleapis.com/x"].map((endpoint) => ({ ...input, endpoint }))]) {
    assert.equal((await api("/subscriptions", "POST", invalid)).status, 400);
  }
  assert.equal(listPushSubscriptions().length, 0);
});

test("authenticated resolution finds the current browser without exposing its capability and status is safe", async () => {
  const input = subscription(); savePushSubscription(input);
  const response = await api("/subscriptions/resolve", "POST", input);
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const secret of [input.endpoint, input.keys.auth, input.keys.p256dh]) assert.ok(!text.includes(secret));
  assert.equal(await (await api("/subscriptions/resolve", "POST", { ...input, keys: { ...input.keys, auth: "wrong" } })).json(), null);
  const status = await api("/status");
  assert.equal(status.headers.get("cache-control"), "no-store");
  const body = await status.text();
  assert.equal(JSON.parse(body).pending, 0);
  assert.ok(!body.includes(input.endpoint) && !body.includes(input.keys.auth));
});

test("push delivery works independently of email, and payloads contain no diagnostic secrets", async () => {
  enablePush(); savePushSubscription(subscription());
  const transport = sent();
  await notifyDeployBlocked("my-app", "SECRET_ENV_VALUE", 7, "attempt-one");
  await notifyHealthCheckFailure("my-app", "https://user:SECRET_PASSWORD@example.com/health", 12, 7, "health_check:7:episode");
  assert.equal(transport.mock.calls.length, 0, "producers enqueue synchronously without HTTP");
  const events = getDatabase().prepare("SELECT payload_json FROM push_events").all() as { payload_json: string }[];
  assert.equal(events.length, 2);
  for (const { payload_json } of events) {
    const payload = JSON.parse(payload_json) as { url: string };
    assert.equal(payload.url, "/projects/7");
    assert.ok(!payload_json.includes("SECRET"));
  }
  await new PushDeliveryWorker().poll();
  const logs = getDatabase().prepare("SELECT channel, result FROM notification_logs").all();
  assert.deepEqual(logs, [{ channel: "web_push", result: "ok" }]);
});

test("global and event preferences suppress delivery, while an explicit test bypasses event preferences", async () => {
  savePushSubscription(subscription());
  const transport = sent();
  await dispatchNotification({ ...event(), eventKey: "health_check:7:disabled" });
  enablePush(); updatePushConfig({ events: { health_check: false } });
  await dispatchNotification({ ...event(), eventKey: "health_check:7:disabled-event" });
  assert.equal(getDatabase().prepare("SELECT id FROM push_events").get(), undefined);
  await sendWebPushNotification({ ...event(), type: "test" });
  assert.equal(transport.mock.calls.length, 1);
});

test("404 and 410 remove dead subscriptions and never expose provider errors", async () => {
  for (const statusCode of [404, 410]) {
    enablePush();
    const input = subscription(String(statusCode));
    savePushSubscription(input);
    mock.method(webpush, "sendNotification", async () => { throw Object.assign(new Error(`${input.endpoint} ${input.keys.auth}`), { statusCode }); });
    const result = await sendWebPushNotification({ ...event(), type: "test" });
    assert.equal(result[0].expired, true);
    assert.equal(listPushSubscriptions().length, 0);
    assert.ok(!JSON.stringify(result).includes(input.endpoint));
    const logs = JSON.stringify(getDatabase().prepare("SELECT * FROM notification_logs").all());
    assert.ok(!logs.includes(input.endpoint) && !logs.includes(input.keys.auth));
    mock.restoreAll();
  }
});

test("temporary failures retain subscriptions, record failure time and allow other browsers to receive", async () => {
  enablePush();
  const one = subscription("one"); savePushSubscription(one); savePushSubscription(subscription("two"));
  mock.method(webpush, "sendNotification", async (subscription: webpush.PushSubscription) => {
    if (subscription.endpoint === one.endpoint) throw Object.assign(new Error("PRIVATE_ERROR"), { statusCode: 503 });
    return { statusCode: 201, headers: {}, body: "" };
  });
  const results = await sendWebPushNotification({ ...event(), type: "test" });
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(listPushSubscriptions().length, 2);
  assert.ok(getDatabase().prepare("SELECT last_failure_at FROM push_subscriptions WHERE endpoint = ?").get(one.endpoint));
  const response = await api("/test", "POST", {});
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(JSON.parse(text).ok, false);
  assert.ok(!text.includes("PRIVATE_ERROR") && !text.includes(one.endpoint));
});

test("email keeps its existing delivery and log even when push fails", async () => {
  const credential = getDatabase().prepare("INSERT INTO credentials (type, alias, secret_enc) VALUES ('api_key', 'notifications', ?)").run(encryptSecret("api-key"));
  getDatabase().prepare("INSERT INTO notification_config (id, enabled, provider, credential_id, from_address, to_address) VALUES (1, 1, 'mw', ?, 'from@example.com', 'to@example.com')").run(credential.lastInsertRowid);
  let emails = 0;
  mock.method(globalThis, "fetch", async () => { emails++; return new Response("{}", { status: 200 }); });
  enablePush(); savePushSubscription(subscription());
  mock.method(webpush, "sendNotification", async () => { throw new Error("offline"); });
  await assert.doesNotReject(notifyDeployBlocked("app", "reason", 7, "email-attempt"));
  await new PushDeliveryWorker().poll();
  assert.equal(emails, 1);
  assert.deepEqual(getDatabase().prepare("SELECT channel, result FROM notification_logs ORDER BY channel").all(),
    [{ channel: "email", result: "ok" }, { channel: "web_push", result: "error" }]);
});

test("dispatcher isolates failures in either channel", async () => {
  const delivered: string[] = [];
  await assert.doesNotReject(dispatchNotification(event(), {
    email: async () => { throw new Error("email down"); }, push: async () => { delivered.push("push"); },
  }));
  await assert.doesNotReject(dispatchNotification(event(), {
    email: async () => { delivered.push("email"); }, push: async () => { throw new Error("push down"); },
  }));
  assert.deepEqual(delivered, ["push", "email"]);
});

test("failed automatic rollback emits its own configurable event", async () => {
  enablePush(); savePushSubscription(subscription());
  const transport = sent();
  await notifyDeployUnhealthy("app", "abc123", "https://example.com/health", "failed", 7, "operation-one");
  await new PushDeliveryWorker().poll();
  assert.equal(transport.mock.calls.length, 2);
  assert.match(String(transport.mock.calls[1].arguments[1]), /rollback failed/);
});

test("update failure delivery is deduplicated across polling and restarts and excludes updater logs", async () => {
  enablePush(); savePushSubscription(subscription());
  const transport = sent();
  const status = { id: "updater-one", status: "failed" as const, output: "SECRET_UPDATER_OUTPUT" };
  await notifySelfUpdateOutcome(status);
  closeDatabase(); initializeDatabase();
  await notifySelfUpdateOutcome(status);
  await notifySelfUpdateOutcome({ ...status, id: "updater-two", status: "success" });
  await new PushDeliveryWorker().poll();
  assert.equal(transport.mock.calls.length, 1);
  assert.ok(!String(transport.mock.calls[0].arguments[1]).includes("SECRET"));
  await notifySelfUpdateOutcome({ ...status, id: "updater-two", status: "rolled-back" });
  await new PushDeliveryWorker().poll();
  assert.equal(transport.mock.calls.length, 2);
});
