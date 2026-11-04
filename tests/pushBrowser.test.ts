import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";

const source = fs.readFileSync(path.join(__dirname, "../client/src/lib/pushNotifications.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function browser(permission = "default", supported = true) {
  const calls: string[] = [];
  const storage = new Map<string, string>();
  const notification = { permission, requestPermission: async () => { calls.push("permission"); notification.permission = "granted"; return "granted"; } };
  let subscription: object | null = null;
  let failSave = false;
  let failRemove = false;
  let failUnsubscribe = false;
  let serverKnown = false;
  let pushEnabled = true;
  let failLookup = false;
  const candidate = { options: {}, toJSON: () => ({ endpoint: "opaque-endpoint", keys: { auth: "auth", p256dh: "public" } }),
    unsubscribe: async () => { calls.push("unsubscribe"); if (failUnsubscribe) throw new Error("browser unavailable"); subscription = null; return true; } };
  const registration = { pushManager: { getSubscription: async () => subscription,
    subscribe: async (options: { userVisibleOnly: boolean }) => {
      assert.equal(options.userVisibleOnly, true);
      calls.push("subscribe"); subscription = candidate; return candidate;
    } } };
  const api = { savePushBrowser: async (data: { label: string }) => {
    calls.push("save"); assert.equal(data.label, "Laptop");
    if (failSave) throw new Error("server unavailable");
    serverKnown = true;
    return { id: 7, label: data.label };
  }, removePushBrowser: async (id: number) => { calls.push(`remove:${id}`); if (failRemove) throw new Error("server unavailable"); serverKnown = false; },
    getPushConfig: async () => { if (failLookup) throw new Error("offline"); return { enabled: pushEnabled, vapidPublicKey: "AQID" }; },
    resolvePushBrowser: async () => serverKnown ? { id: 7, label: "Laptop" } : null };
  const exported: Record<string, (...args: unknown[]) => unknown> = {};
  const window = supported ? { isSecureContext: true, PushManager: {}, Notification: notification } : { isSecureContext: false };
  const navigator = supported ? { serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration } } : {};
  vm.runInNewContext(compiled, { exports: exported, require: () => ({ api }), window, navigator, Notification: notification,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    Uint8Array, setTimeout, clearTimeout, atob: (value: string) => Buffer.from(value, "base64").toString("binary") });
  return { calls, api: exported, storage,
    failSave: () => { failSave = true; }, failRemove: () => { failRemove = true; },
    failUnsubscribe: (value = true) => { failUnsubscribe = value; }, loseServer: () => { serverKnown = false; },
    loseLocal: () => { subscription = null; }, disablePush: () => { pushEnabled = false; }, failLookup: () => { failLookup = true; },
    denyPermission: () => { notification.permission = "denied"; },
    mismatch: () => { (candidate.options as { applicationServerKey?: ArrayBuffer }).applicationServerKey = Uint8Array.from([9, 9, 9]).buffer; } };
}

test("unsupported/default/denied states never request permission on load", () => {
  const unsupported = browser("default", false);
  assert.equal(unsupported.api["browserPushPermission"](), "unsupported");
  for (const permission of ["default", "denied", "granted"]) {
    const client = browser(permission);
    assert.equal(client.api["browserPushPermission"](), permission);
    assert.deepEqual(client.calls, []);
  }
});

test("denied permission does not repeatedly prompt", async () => {
  const client = browser("denied");
  await assert.rejects(client.api["enableBrowserPush"]("AQID", "Laptop") as Promise<unknown>, /site settings/);
  assert.deepEqual(client.calls, []);
});

test("enabling prompts only on explicit action, posts the subscription and tracks this browser", async () => {
  const client = browser();
  await client.api["enableBrowserPush"]("AQID", "Laptop");
  assert.deepEqual(client.calls, ["permission", "subscribe", "save"]);
  assert.equal(client.api["currentPushBrowserId"](), 7);
  await client.api["disableBrowserPush"](7);
  assert.deepEqual(client.calls.slice(-2), ["remove:7", "unsubscribe"]);
  assert.equal(client.api["currentPushBrowserId"](), null);
});

test("losing localStorage reconciles through the real subscription without a permission prompt", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop");
  client.storage.clear();
  const state = await client.api["reconcileBrowserPush"]("AQID") as { registered: boolean; id: number };
  assert.equal(state.registered, true); assert.equal(state.id, 7);
  assert.equal(client.api["currentPushBrowserId"](), 7);
  assert.ok(!client.calls.includes("permission"));
});

test("a missing restored DB registration is detected and repaired only by explicit registration", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop");
  client.loseServer();
  const state = await client.api["reconcileBrowserPush"]("AQID") as { registered: boolean; local: boolean };
  assert.equal(state.registered, false); assert.equal(state.local, true);
  await client.api["enableBrowserPush"]("AQID", "Laptop");
  assert.equal(client.calls.filter((call) => call === "subscribe").length, 1, "reuses local capability");
  assert.equal(client.calls.filter((call) => call === "save").length, 2);
});

test("VAPID mismatch is visible on refresh and replaces the subscription only on explicit action", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop");
  client.mismatch();
  const state = await client.api["reconcileBrowserPush"]("AQID") as { keyMismatch: boolean; registered: boolean };
  assert.equal(state.keyMismatch, true); assert.equal(state.registered, false);
  assert.ok(!client.calls.includes("unsubscribe"));
  await client.api["enableBrowserPush"]("AQID", "Laptop");
  assert.deepEqual(client.calls.slice(-4), ["remove:7", "unsubscribe", "subscribe", "save"]);
});

test("server removal failure retains local subscription so disabling can be retried", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop"); client.failRemove();
  await assert.rejects(client.api["disableBrowserPush"](7) as Promise<unknown>, /server unavailable/);
  assert.ok(!client.calls.includes("unsubscribe"));
  assert.equal(client.api["currentPushBrowserId"](), 7);
});

test("local removal failure follows server cancellation and exposes a recoverable retry state", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop"); client.failUnsubscribe();
  await assert.rejects(client.api["disableBrowserPush"](7) as Promise<unknown>, /Server alerts are disabled/);
  const state = await client.api["reconcileBrowserPush"]("AQID") as { removalPending: boolean; registered: boolean };
  assert.equal(state.removalPending, true); assert.equal(state.registered, false);
  client.failUnsubscribe(false); await client.api["disableBrowserPush"](7);
  assert.equal(client.api["currentPushBrowserId"](), null);
});

test("server registration failure undoes a newly created browser subscription", async () => {
  const client = browser("granted"); client.failSave();
  await assert.rejects(client.api["enableBrowserPush"]("AQID", "Laptop") as Promise<unknown>, /server unavailable/);
  assert.deepEqual(client.calls, ["subscribe", "save", "unsubscribe"]);
  assert.equal(client.api["currentPushBrowserId"](), null);
});

test("startup recovery checks do not prompt or warn browsers that never opted in", async () => {
  for (const permission of ["default", "denied", "granted"]) {
    const client = browser(permission);
    assert.equal(await client.api["browserPushRecoveryNeeded"](), false);
    assert.deepEqual(client.calls, []);
  }
  const unsupported = browser("default", false);
  assert.equal(await unsupported.api["browserPushRecoveryNeeded"](), false);
});

test("startup detects server expiry and key drift without changing subscriptions or prompting", async () => {
  for (const drift of ["server", "key", "permission"] as const) {
    const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop");
    if (drift === "server") { client.storage.clear(); client.loseServer(); }
    if (drift === "key") client.mismatch();
    if (drift === "permission") client.denyPermission();
    assert.equal(await client.api["browserPushRecoveryNeeded"](), true);
    assert.equal(await client.api["browserPushRecoveryNeeded"](), true);
    assert.deepEqual(client.calls, ["subscribe", "save"]);
  }
});

test("lost local subscription remains visible across checks and clears after explicit repair", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop");
  client.loseLocal();
  assert.equal(await client.api["browserPushRecoveryNeeded"](), true);
  assert.equal(client.api["currentPushBrowserId"](), null);
  assert.equal(await client.api["browserPushRecoveryNeeded"](), true, "lost numeric hint must not erase previous opt-in intent");
  await client.api["enableBrowserPush"]("AQID", "Laptop");
  assert.equal(await client.api["browserPushRecoveryNeeded"](), false);
  await client.api["disableBrowserPush"](7);
  assert.equal(await client.api["browserPushRecoveryNeeded"](), false);
  assert.ok(!client.calls.includes("permission"));
});

test("global disable and intentional partial browser removal do not show a repair warning", async () => {
  const disabled = browser("granted"); await disabled.api["enableBrowserPush"]("AQID", "Laptop");
  disabled.loseServer(); disabled.disablePush();
  assert.equal(await disabled.api["browserPushRecoveryNeeded"](), false);
  const removing = browser("granted"); await removing.api["enableBrowserPush"]("AQID", "Laptop");
  removing.failUnsubscribe();
  await assert.rejects(removing.api["disableBrowserPush"](7) as Promise<unknown>);
  assert.equal(await removing.api["browserPushRecoveryNeeded"](), false);
});

test("an unavailable server does not classify an intact browser registration as broken", async () => {
  const client = browser("granted"); await client.api["enableBrowserPush"]("AQID", "Laptop");
  client.failLookup();
  await assert.rejects(client.api["browserPushRecoveryNeeded"]() as Promise<unknown>, /offline/);
  assert.equal(client.api["currentPushBrowserId"](), 7);
  assert.deepEqual(client.calls, ["subscribe", "save"]);
});
