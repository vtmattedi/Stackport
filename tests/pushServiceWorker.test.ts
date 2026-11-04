import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";

const source = fs.readFileSync(path.join(__dirname, "../client/src/sw.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: { title: string; options: { body: string; tag?: string; data: { url: string } } }[] = [];
  const opened: string[] = [];
  const navigation: string[] = [];
  const lifecycle: string[] = [];
  let focused = 0;
  let windows: object[] = [];
  const self = {
    __WB_MANIFEST: [{ url: "/index.html", revision: "one" }],
    location: { origin: "https://stackport.example.com" },
    addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; },
    skipWaiting: async () => { lifecycle.push("skipWaiting"); },
    registration: { showNotification: async (title: string, options: typeof shown[number]["options"]) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); },
    },
  };
  const imports: Record<string, unknown> = {
    "workbox-core": { clientsClaim: () => lifecycle.push("clientsClaim"), setCacheNameDetails: () => {} },
    "workbox-precaching": { precacheAndRoute: () => lifecycle.push("precache"), cleanupOutdatedCaches: () => lifecycle.push("cleanup"), createHandlerBoundToURL: () => () => {} },
    "workbox-routing": { NavigationRoute: class {}, registerRoute: () => {} },
  };
  vm.runInNewContext(compiled, { self, URL, exports: {}, __APP_VERSION__: "test", require: (name: string) => imports[name] });
  async function fire(name: string, data: object) {
    let completion: Promise<unknown> | undefined;
    handlers[name]({ ...data, waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
    assert.ok(completion, "event keeps the service worker alive until work completes");
    await completion;
  }
  return { shown, opened, navigation, lifecycle, fire, sendMessage: (data: unknown) => handlers["message"]({ data }), get focused() { return focused; },
    useWindow(url = "https://stackport.example.com/projects") {
      const client = { url, navigate: async (target: string) => { navigation.push(target); return client; }, focus: async () => { focused++; } };
      windows = [client];
    },
  };
}

test("push is shown by the service worker with its body and internal destination", async () => {
  const sw = worker();
  await sw.fire("push", { data: { json: () => ({ title: "Unhealthy", body: "Check your project", url: "/projects/7", tag: "health:7" }) } });
  assert.equal(sw.shown[0].title, "Unhealthy");
  assert.equal(sw.shown[0].options.body, "Check your project");
  assert.equal(sw.shown[0].options.data.url, "/projects/7");
});

test("malformed and empty pushes still display a safe generic notification", async () => {
  const sw = worker();
  await sw.fire("push", { data: { json: () => { throw new Error("malformed"); } } });
  await sw.fire("push", {});
  assert.equal(sw.shown.length, 2);
  assert.equal(sw.shown[0].title, "Stackport alert");
});

test("versioned incident tags collapse retries while preserving separate incidents", async () => {
  const sw = worker();
  for (const eventKey of ["health_check:7:first", "health_check:7:first", "health_check:7:second"]) {
    await sw.fire("push", { data: { json: () => ({ version: 1, eventKey, title: "Unhealthy", body: "Open Stackport", url: "/projects/7" }) } });
  }
  assert.equal(sw.shown[0].options.tag, sw.shown[1].options.tag);
  assert.notEqual(sw.shown[0].options.tag, sw.shown[2].options.tag);
});

test("a click closes the notification, navigates and focuses an existing Stackport window", async () => {
  const sw = worker();
  sw.useWindow();
  let closed = false;
  await sw.fire("notificationclick", { notification: { data: { url: "/projects/7" }, close: () => { closed = true; } } });
  assert.equal(closed, true);
  assert.equal(sw.focused, 1);
  assert.deepEqual(sw.navigation, ["/projects/7"]);
  assert.deepEqual(sw.opened, []);
});

test("a click opens Stackport when no window exists and ignores external destinations", async () => {
  for (const [target, expected] of [["/settings/general", "/settings/general"], ["https://evil.example/", "/"], ["//evil.example/", "/"], ["/\\evil.example/", "/"]]) {
    const sw = worker();
    await sw.fire("notificationclick", { notification: { data: { url: target }, close: () => {} } });
    assert.deepEqual(sw.opened, [expected]);
  }
});

test("custom worker retains precaching, old-cache cleanup and automatic activation/client claiming", () => {
  assert.deepEqual(worker().lifecycle, ["precache", "cleanup", "skipWaiting", "clientsClaim"]);
});
