import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { hashApiTokenValue } from "../src/modules/identity/apiTokens";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { listProjectEnvFiles } from "../src/modules/projects/envFiles";
import { createProject } from "../src/modules/projects/operations";
import app from "../src/app";

let server: Server;
let base: string;
let session: string;

const REDIRECT = "http://127.0.0.1:8123/callback";

before(async () => {
  initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  session = issueAuthToken("admin");
});

after(() => { server.close(); });

const admin = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}/api/oauth${path}`, { ...init, headers: { authorization: `Bearer ${session}`, "content-type": "application/json", ...(init.headers ?? {}) } });

async function register(): Promise<{ client_id: string }> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(clientId: string, challenge: string): Promise<string> {
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!, base);
  assert.equal(location.pathname, "/oauth/consent");
  return location.searchParams.get("request")!;
}

async function approve(request: string, body: object): Promise<string> {
  const res = await admin(`/requests/${request}/approve`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  const redirect = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, REDIRECT);
  assert.equal(redirect.searchParams.get("state"), "xyz");
  return redirect.searchParams.get("code")!;
}

function tokenRequest(params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
}

async function toolNames(bearer: string): Promise<string[]> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
}

test("an unauthenticated /mcp request points the client at the OAuth metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("discovery metadata names the authorize, token and registration endpoints", async () => {
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.match(String(as["authorization_endpoint"]), /\/authorize$/);
  assert.match(String(as["token_endpoint"]), /\/token$/);
  assert.match(String(as["registration_endpoint"]), /\/register$/);
  assert.deepEqual(as["code_challenge_methods_supported"], ["S256"]);
  const rs = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  assert.match(String(rs["resource"]), /\/mcp$/);
});

test("the consent API needs an admin session", async () => {
  const res = await fetch(`${base}/api/oauth/requests/anything`);
  assert.equal(res.status, 401);
});

test("approve, exchange the code with PKCE, call /mcp, refresh, and revoke", async () => {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const request = await authorize(client_id, challenge);

  const info = (await (await admin(`/requests/${request}`)).json()) as { clientName: string; redirectHost: string };
  assert.equal(info.clientName, "Test client");
  assert.equal(info.redirectHost, "127.0.0.1:8123");

  const code = await approve(request, { scope: "read", logs: true });
  assert.equal((await admin(`/requests/${request}/approve`, { method: "POST", body: JSON.stringify({ scope: "read" }) })).status, 404, "a request is answered once");

  const wrong = await tokenRequest({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: pkce().verifier });
  assert.equal(wrong.status, 400, "the wrong PKCE verifier is refused");

  const exchanged = await tokenRequest({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(exchanged.status, 200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, "Bearer");

  const reused = await tokenRequest({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(reused.status, 400, "a code works once");

  const tools = await toolNames(tokens.access_token);
  assert.ok(tools.includes("stackport_list_projects"));
  assert.ok(tools.includes("stackport_get_project_logs"));
  assert.ok(!tools.includes("stackport_get_project_action_log"), "container log consent grants no deployment log access");
  assert.ok(!tools.some((name) => /deploy|restart|stop|rollback/.test(name)), "a read grant gets no write tools");

  const listed = (await (await admin("/connections")).json()) as { id: number; clientName: string }[];
  assert.ok(listed.some((app) => app.clientName === "Test client"));

  const refreshed = await tokenRequest({ grant_type: "refresh_token", client_id, refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(next.access_token, tokens.access_token);
  const stale = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` }, body: "{}" });
  assert.equal(stale.status, 401, "rotating a refresh token ends the access token it issued");
  assert.ok((await toolNames(next.access_token)).includes("stackport_status"));

  const revoke = await fetch(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id, token: next.refresh_token }).toString() });
  assert.equal(revoke.status, 200);
  const after = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${next.access_token}` }, body: "{}" });
  assert.equal(after.status, 401, "revoking the refresh token ends the access token too");
});

test("OAuth refresh keeps a pending env write bound to the same grant", async () => {
  const { id: projectId } = createProject({ name: "OAuth env test", sourceType: "upload" });
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const code = await approve(await authorize(client_id, challenge), { scope: "write", actionLogs: true });
  const first = await (await tokenRequest({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: verifier })).json() as {
    access_token: string; refresh_token: string; expires_in: number;
  };
  assert.equal(first.expires_in, 3600);
  const tools = await toolNames(first.access_token);
  assert.ok(tools.includes("stackport_deploy_project"));
  assert.ok(tools.includes("stackport_get_project_action_log"));
  assert.ok(!tools.includes("stackport_get_project_logs"));
  const list = await (await fetch(`${base}/api/api-tokens`, { headers: { authorization: `Bearer ${session}` } })).json() as { name: string }[];
  assert.ok(!list.some((token) => token.name.startsWith("OAuth:")));

  async function generate(bearer: string, args: Record<string, unknown>) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stackport_generate_project_env_value", arguments: args } }),
    });
    assert.equal(res.status, 200);
    return (await res.json() as { result: { structuredContent?: Record<string, unknown>; isError?: boolean } }).result;
  }

  const args = { projectId, relativePath: ".env", key: "BLIND_SECRET", size: 24, format: "b64url" };
  const preview = await generate(first.access_token, args);
  assert.deepEqual(listProjectEnvFiles(projectId), []);
  assert.equal(typeof preview.structuredContent?.["confirmationId"], "string");

  const hash = hashApiTokenValue(first.refresh_token);
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").get(hash) as { created_at: string; expires_at: string };
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 30 * 86_400_000);
  db.prepare("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE token_hash = ?").run(new Date(Date.now() + 30_000).toISOString(), hash);

  const refresh = await tokenRequest({ grant_type: "refresh_token", client_id, refresh_token: first.refresh_token });
  assert.equal(refresh.status, 200);
  const next = await refresh.json() as { access_token: string; refresh_token: string };
  const nextHash = hashApiTokenValue(next.refresh_token);
  const rotated = db.prepare("SELECT expires_at FROM oauth_refresh_tokens WHERE token_hash = ?").get(nextHash) as { expires_at: string };
  assert.ok(Date.parse(rotated.expires_at) > Date.now() + 29 * 86_400_000);

  const confirmationId = preview.structuredContent?.["confirmationId"];
  const confirmed = await generate(next.access_token, { ...args, confirmationId });
  assert.deepEqual(confirmed.structuredContent, { ok: true });
  assert.match(listProjectEnvFiles(projectId)[0].variables[0].value, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await generate(next.access_token, { ...args, confirmationId })).isError, true);

  db.prepare("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE token_hash = ?").run(new Date(Date.now() - 1_000).toISOString(), nextHash);
  assert.equal((await tokenRequest({ grant_type: "refresh_token", client_id, refresh_token: next.refresh_token })).status, 400);
});

test("denying sends access_denied to the client and issues nothing", async () => {
  const { client_id } = await register();
  const request = await authorize(client_id, pkce().challenge);
  const res = await admin(`/requests/${request}/deny`, { method: "POST" });
  const redirect = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "xyz");
  assert.equal(redirect.searchParams.get("code"), null);
});

test("authorize refuses a redirect_uri the client did not register", async () => {
  const { client_id } = await register();
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://evil.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 400);
});

async function registerWith(redirectUri: string): Promise<Response> {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Tester", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
}

test("registration refuses redirect addresses that could run code or send a code somewhere unsafe", async () => {
  for (const uri of ["javascript:alert(document.cookie)", "data:text/html,<script>1</script>", "vbscript:x", "file:///etc/passwd", "http://evil.example/cb", "https://user:pass@evil.example/cb", "https://evil.example/cb#frag", "app:no-slashes"]) {
    assert.equal((await registerWith(uri)).status, 400, `${uri} is refused`);
  }
  for (const uri of ["https://claude.ai/api/mcp/auth_callback", "http://localhost:3118/cb", "cursor://anysphere.cursor-retrieval/oauth/callback"]) {
    assert.equal((await registerWith(uri)).status, 201, `${uri} is accepted`);
  }
});

test("a client that sends the approval to a web address needs the admin to confirm that host", async () => {
  const web = "https://claude.ai/api/mcp/auth_callback";
  const { client_id } = (await (await registerWith(web)).json()) as { client_id: string };
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: web, code_challenge: pkce().challenge, code_challenge_method: "S256" }).toString();
  const request = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!, base).searchParams.get("request")!;
  const info = (await (await admin(`/requests/${request}`)).json()) as { local: boolean; redirectUri: string; redirectHost: string };
  assert.equal(info.local, false);
  assert.equal(info.redirectUri, web);
  assert.equal((await admin(`/requests/${request}/approve`, { method: "POST", body: JSON.stringify({ scope: "read" }) })).status, 400, "no confirmation, no approval");
  assert.equal((await admin(`/requests/${request}/approve`, { method: "POST", body: JSON.stringify({ scope: "read", confirmHost: "other.example" }) })).status, 400, "the wrong host does not confirm");
  assert.equal((await admin(`/requests/${request}/approve`, { method: "POST", body: JSON.stringify({ scope: "read", confirmHost: info.redirectHost }) })).status, 200);
});

test("replaying a rotated refresh token ends the whole connection", async () => {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const code = await approve(await authorize(client_id, challenge), { scope: "read" });
  const first = (await (await tokenRequest({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: verifier })).json()) as { access_token: string; refresh_token: string };
  const second = (await (await tokenRequest({ grant_type: "refresh_token", client_id, refresh_token: first.refresh_token })).json()) as { access_token: string; refresh_token: string };
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
  getDatabase().prepare("UPDATE oauth_refresh_tokens SET revoked_at = ?, rotated_at = ? WHERE token_hash = ?")
    .run(eightDaysAgo, eightDaysAgo, hashApiTokenValue(first.refresh_token));
  await authorize(client_id, pkce().challenge); // Triggers housekeeping while the rotated token still has time left.
  assert.equal((await tokenRequest({ grant_type: "refresh_token", client_id, refresh_token: first.refresh_token })).status, 400, "the replay is refused");
  assert.equal((await tokenRequest({ grant_type: "refresh_token", client_id, refresh_token: second.refresh_token })).status, 400, "and the newer refresh token no longer works either");
  const ping = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${second.access_token}` }, body: "{}" });
  assert.equal(ping.status, 401, "nor does the newer access token");
});

test("another client's refresh token or code cannot be redeemed", async () => {
  const a = await register();
  const b = await register();
  const { verifier, challenge } = pkce();
  const code = await approve(await authorize(a.client_id, challenge), { scope: "write" });
  assert.equal((await tokenRequest({ grant_type: "authorization_code", client_id: b.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier })).status, 400);
  const tokens = (await (await tokenRequest({ grant_type: "authorization_code", client_id: a.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier })).json()) as { refresh_token: string };
  assert.equal((await tokenRequest({ grant_type: "refresh_token", client_id: b.client_id, refresh_token: tokens.refresh_token })).status, 400);
});

test("the issuer never comes from a request header, and OAuth routing leaves other paths alone", async () => {
  const { request } = await import("http");
  const get = (path: string, host: string): Promise<{ status: number; headers: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const port = (server.address() as AddressInfo).port;
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }); });
    req.on("error", reject);
    req.end();
  });
  assert.equal((await get("/.well-known/oauth-authorization-server", "evil.example")).status, 404, "a foreign Host gets no OAuth metadata");
  assert.equal((await get("/health", "evil.example")).status, 200, "and the rest of the app still answers it");
  assert.equal((await get("/api/not-a-route", "evil.example")).status, 404);
  const challenge: Record<string, unknown> = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const port = (server.address() as AddressInfo).port;
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example\"x", "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.headers); });
    req.on("error", reject);
    req.end("{}");
  }).catch((): Record<string, unknown> => ({}));
  assert.equal(challenge["www-authenticate"], undefined, "a hostile Host is never echoed into the challenge");
});

test("a grant cannot name a project group that does not exist", async () => {
  const { client_id } = await register();
  const request = await authorize(client_id, pkce().challenge);
  const res = await admin(`/requests/${request}/approve`, { method: "POST", body: JSON.stringify({ scope: "write", projectGroup: "no-such-group" }) });
  assert.equal(res.status, 400);
});
