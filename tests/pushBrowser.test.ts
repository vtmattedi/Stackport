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
  const candidate = { options: {}, toJSON: () => ({ endpoint: "opaque-endpoint", keys: { auth: "auth", p256dh: "public" } }),
    unsubscribe: async () => { calls.push("unsubscribe"); subscription = null; return true; } };
  const registration = { pushManager: { getSubscription: async () => subscription,
    subscribe: async (options: { userVisibleOnly: boolean }) => {
      assert.equal(options.userVisibleOnly, true);
      calls.push("subscribe"); subscription = candidate; return candidate;
    } } };
  const api = { savePushBrowser: async (data: { label: string }) => {
    calls.push("save"); assert.equal(data.label, "Laptop");
    if (failSave) throw new Error("server unavailable");
    return { id: 7, label: data.label };
  }, removePushBrowser: async (id: number) => { calls.push(`remove:${id}`); } };
  const exported: Record<string, (...args: unknown[]) => unknown> = {};
  const window = supported ? { isSecureContext: true, PushManager: {}, Notification: notification } : { isSecureContext: false };
  const navigator = supported ? { serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration } } : {};
  vm.runInNewContext(compiled, { exports: exported, require: () => ({ api }), window, navigator, Notification: notification,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    Uint8Array, setTimeout, clearTimeout, atob: (value: string) => Buffer.from(value, "base64").toString("binary") });
  return { calls, api: exported, failSave: () => { failSave = true; } };
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
  assert.deepEqual(client.calls.slice(-2), ["unsubscribe", "remove:7"]);
  assert.equal(client.api["currentPushBrowserId"](), null);
});

test("server registration failure undoes a newly created browser subscription", async () => {
  const client = browser("granted"); client.failSave();
  await assert.rejects(client.api["enableBrowserPush"]("AQID", "Laptop") as Promise<unknown>, /server unavailable/);
  assert.deepEqual(client.calls, ["subscribe", "save", "unsubscribe"]);
  assert.equal(client.api["currentPushBrowserId"](), null);
});
