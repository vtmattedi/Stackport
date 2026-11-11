import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { createState } from "../src/modules/github/store";
import app from "../src/app";

let server: Server;
let base: string;
let token: string;

before(async () => {
  initializeDatabase();
  getDatabase().prepare("DELETE FROM github_app").run();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = issueAuthToken("admin");
});
after(() => { server.close(); });

const get = (path: string, auth = false): Promise<Response> =>
  fetch(`${base}/api/github-app${path}`, { redirect: "manual", headers: auth ? { Authorization: `Bearer ${token}` } : {} });

test("everything except the three browser callbacks needs a login", async () => {
  assert.equal((await get("")).status, 401);
  assert.equal((await get("/repositories")).status, 401);
  for (const [method, path] of [["POST", "/manifest/start"], ["POST", "/link/start"], ["POST", "/installations/sync"], ["POST", "/installations/1/refresh"], ["DELETE", ""]] as const) {
    assert.equal((await fetch(`${base}/api/github-app${path}`, { method })).status, 401, `${method} ${path}`);
  }
});

test("the status page works for an admin before any App exists, and says what is missing", async () => {
  const res = await get("", true);
  assert.equal(res.status, 200);
  const body = await res.json() as { app: unknown; preflight: { ok: boolean; problems: string[] }; installations: unknown[]; modules: string[] };
  assert.equal(body.app, null);
  assert.equal(body.preflight.ok, false);
  assert.ok(body.preflight.problems.length > 0);
  assert.deepEqual(body.modules, ["deployments", "ci", "releases"]);
});

test("the callbacks send the browser back to the settings page with our own message, never an echo of the request", async () => {
  const evil = "<script>alert(1)</script>";
  for (const path of [`/manifest/callback?code=abc&state=${encodeURIComponent(evil)}`, `/oauth/callback?code=${encodeURIComponent(evil)}&state=${"a".repeat(64)}`]) {
    const res = await get(path);
    assert.equal(res.status, 303, path);
    const location = res.headers.get("location") ?? "";
    assert.match(location, /^\/settings\/github\?/);
    assert.ok(!location.includes("script") && !location.includes("alert"), "nothing from the query string is reflected");
    assert.match(new URL(location, base).searchParams.get("error") ?? "", /.+/);
  }
});

test("a registration callback with a real state but no code from GitHub is refused, and the state is spent", async () => {
  const state = createState("manifest", "admin");
  const res = await get(`/manifest/callback?state=${state}`);
  assert.equal(res.status, 303);
  assert.match(new URL(res.headers.get("location") ?? "", base).searchParams.get("error") ?? "", /code from GitHub/);
  const again = await get(`/manifest/callback?code=abc&state=${state}`);
  assert.match(new URL(again.headers.get("location") ?? "", base).searchParams.get("error") ?? "", /expired or was already used/);
});

test("the setup URL never trusts the installation id it is given", async () => {
  const res = await get("/setup?installation_id=999&setup_action=install");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/settings/github?installed=1");
  const rows = getDatabase().prepare("SELECT COUNT(*) AS n FROM github_app_installations WHERE installation_id = 999").get() as { n: number };
  assert.equal(rows.n, 0);
});

test("starting a registration without a domain is refused with the reason", async () => {
  const res = await fetch(`${base}/api/github-app/manifest/start`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 412);
  assert.match(((await res.json()) as { error: string }).error, /domain/i);
});
