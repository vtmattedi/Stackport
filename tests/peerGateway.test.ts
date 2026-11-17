import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import Database from "better-sqlite3";
import migration from "../src/migrations/021_peers";
import { ensureInstanceIdentity, setInstanceName } from "../src/modules/backup/instance";
import { matchRule } from "../src/modules/peers/gateway";
import { issuePairingCode, registerTarget, remoteCall, PeerError } from "../src/modules/peers/service";

/** B is this process's real application: its real routes, services and database, behind the real control router. A is a bare in-memory controller. */
async function startB(): Promise<{ url: string; db: Database.Database; stop: () => Promise<void> }> {
  const { default: app } = await import("../src/app");
  const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/config/database");
  initializeDatabase();
  const db = getDatabase();
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, db,
    stop: async () => { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); closeDatabase(); },
  };
}

function controller(name: string): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  migration.up(db);
  ensureInstanceIdentity(db);
  setInstanceName(name, db);
  return db;
}

const opId = (): string => `op-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const count = (db: Database.Database, name: string): number => (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = ?").get(name) as { n: number }).n;

test("the allow-list: what a peer can reach, and what it cannot", () => {
  assert.equal(matchRule("POST", "/projects")?.grant, "projects:write");
  assert.equal(matchRule("POST", "/projects/12/deploy")?.grant, "projects:write");
  assert.equal(matchRule("GET", "/projects/12/domains")?.grant, "projects:read");
  assert.equal(matchRule("GET", "/actions/running")?.grant, "projects:read");
  // Not on the list at all, whatever the application router has:
  for (const [method, path] of [
    ["DELETE", "/projects/12"], ["POST", "/projects/12/stop-purge"], ["POST", "/projects/12/containers/web/drop-volumes"], ["GET", "/projects/12/env-files"], ["POST", "/projects/12/upload"],
    ["GET", "/peers"], ["DELETE", "/peers/controllers/1"], ["POST", "/admin/password"], ["GET", "/system/update"], ["POST", "/credentials"], ["GET", "/encryption"], ["POST", "/domains"], ["POST", "/api-tokens"],
    ["GET", "/projects/12/../../peers"], ["POST", "/projects/abc/deploy"], ["GET", "/projects/12/webhook"],
    // the controls that keep a Compose file away from the host are not project configuration
    ["PUT", "/projects/12/compose-policy-enforcement"], ["PUT", "/projects/12/hardening"], ["PUT", "/projects/12/ingress-isolation"],
  ] as const) assert.equal(matchRule(method, path), null, `${method} ${path}`);
});

test("create, configure and operate a project on the peer: the peer's own services do it, and the peer owns the result", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:write"] }, b.db);
    const target = await registerTarget(code, a);

    const created = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "remote-one", sourceType: "upload" }, operationId: opId() }, a);
    assert.equal(created.status, 201);
    const project = created.body as { id: number; name: string };
    assert.equal(count(b.db, "remote-one"), 1, "the project exists in B's own database");

    const patched = await remoteCall(target.id, { method: "PATCH", path: `/projects/${project.id}`, body: { name: "remote-renamed" }, operationId: opId() }, a);
    assert.equal(patched.status, 200);
    assert.equal(count(b.db, "remote-renamed"), 1);

    const paused = await remoteCall(target.id, { method: "POST", path: `/projects/${project.id}/pause`, body: {}, operationId: opId() }, a);
    assert.equal(paused.status < 300, true);
    assert.equal((b.db.prepare("SELECT paused FROM projects WHERE id = ?").get(project.id) as { paused: number }).paused, 1);

    const domains = await remoteCall(target.id, { method: "GET", path: `/projects/${project.id}/domains` }, a);
    assert.equal(domains.status, 200);
    assert.ok(Array.isArray(domains.body));

    // The peer's own validation answers as it would to its own UI.
    const bad = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "" }, operationId: opId() }, a);
    assert.equal(bad.status, 400);
  } finally { a.close(); await b.stop(); }
});

test("a write is idempotent: repeating an operation id returns the first result and changes nothing", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:write"] }, b.db);
    const target = await registerTarget(code, a);
    const id = opId();
    const first = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "once-only", sourceType: "upload" }, operationId: id }, a);
    assert.equal(first.status, 201);
    assert.equal(first.replayed, false);

    const again = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "once-only", sourceType: "upload" }, operationId: id }, a);
    assert.equal(again.status, 201, "the first status, not a name conflict");
    assert.equal(again.replayed, true);
    assert.deepEqual(again.body, first.body);
    assert.equal(count(b.db, "once-only"), 1, "nothing ran twice");

    const different = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "other", sourceType: "upload" }, operationId: id }, a);
    assert.equal(different.status, 409);
    assert.equal((different.body as { code: string }).code, "operation-conflict");
    assert.equal(count(b.db, "other"), 0);

    const missing = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "no-id", sourceType: "upload" } }, a);
    assert.equal(missing.status, 400);
    assert.equal((missing.body as { code: string }).code, "operation-required");
    assert.equal(count(b.db, "no-id"), 0);
  } finally { a.close(); await b.stop(); }
});

test("a controller is held to its grants, and routes outside the allow-list do not exist for it", async () => {
  const b = await startB();
  const reader = controller("Reader");
  const writer = controller("Writer");
  try {
    const pairReader = await registerTarget(issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db).code, reader);
    const pairWriter = await registerTarget(issuePairingCode({ endpoint: b.url, grants: ["projects:write"] }, b.db).code, writer);

    // read-only: may look, may not change
    const seen = await remoteCall(pairReader.id, { method: "GET", path: "/actions/running" }, reader);
    assert.equal(seen.status, 200);
    const refused = await remoteCall(pairReader.id, { method: "POST", path: "/projects", body: { name: "nope", sourceType: "upload" }, operationId: opId() }, reader);
    assert.equal(refused.status, 403);
    assert.equal((refused.body as { code: string }).code, "forbidden");
    assert.equal(count(b.db, "nope"), 0);
    assert.equal((await remoteCall(pairReader.id, { method: "GET", path: "/credentials" }, reader)).status, 403, "credential aliases need write");

    // write: still not host administration, other peers, env files or deletion
    for (const [method, path] of [["GET", "/peers"], ["POST", "/admin/password"], ["GET", "/projects/1/env-files"], ["DELETE", "/projects/1"], ["POST", "/projects/1/stop-purge"]] as const) {
      const answer = await remoteCall(pairWriter.id, { method, path, body: method === "GET" ? undefined : {}, operationId: method === "GET" ? undefined : opId() }, writer);
      assert.equal(answer.status, 404, `${method} ${path}`);
    }
    const credentials = await remoteCall(pairWriter.id, { method: "GET", path: "/credentials" }, writer);
    assert.equal(credentials.status, 200);
    assert.ok(!JSON.stringify(credentials.body).includes("secret_enc"), "aliases and types only");
  } finally { reader.close(); writer.close(); await b.stop(); }
});

test("the application's own API is not open to a request that merely claims to be a peer", async () => {
  const b = await startB();
  try {
    // No session and no peer principal: a forged control header changes nothing.
    const response = await fetch(`${b.url}/api/projects`, { headers: { "X-SP-Instance": "x", "X-SP-Protocol": "1" } });
    assert.equal(response.status, 401);
    const post = await fetch(`${b.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-sp-operation": "op-12345678" }, body: JSON.stringify({ name: "forged", sourceType: "upload" }) });
    assert.equal(post.status, 401);
    assert.equal(count(b.db, "forged"), 0);
    // And an unsigned call to the control gateway is refused before any route runs.
    const unsigned = await fetch(`${b.url}/control/v1/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unsigned.status === 401 || unsigned.status === 421 || unsigned.status === 426, true);
  } finally { await b.stop(); }
});

test("an unknown peer error surfaces as a PeerError, not as the peer's data", async () => {
  const a = controller("Alpha");
  try {
    await assert.rejects(remoteCall(99, { method: "GET", path: "/projects/1/domains" }, a), (e: PeerError) => e.status === 404);
  } finally { a.close(); }
});

test("a peer cannot inject raw nginx directives, and sees only the actions started for projects", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const target = await registerTarget(issuePairingCode({ endpoint: b.url, grants: ["projects:write"] }, b.db).code, a);
    const created = await remoteCall(target.id, { method: "POST", path: "/projects", body: { name: "scoped", sourceType: "upload" }, operationId: opId() }, a);
    const projectId = (created.body as { id: number }).id;

    for (const field of ["nginxExtraConfig", "nginxExtraBlocks"]) {
      const refused = await remoteCall(target.id, { method: "PATCH", path: `/projects/${projectId}`, body: { [field]: "location / { return 200; }" }, operationId: opId() }, a);
      assert.equal(refused.status, 403, field);
      assert.equal((refused.body as { code: string }).code, "forbidden-field");
    }
    assert.equal((b.db.prepare("SELECT nginx_extra_config FROM projects WHERE id = ?").get(projectId) as { nginx_extra_config: string | null }).nginx_extra_config, null);

    // A project's action is readable; a host-level one (an update, a backup) does not exist for a peer.
    const projectAction = "11111111-1111-4111-8111-111111111111";
    const hostAction = "22222222-2222-4222-8222-222222222222";
    b.db.prepare("INSERT INTO actions (id, key, kind, project_id, status, started_at) VALUES (?, 'k1', 'deploy', ?, 'success', ?)").run(projectAction, projectId, new Date().toISOString());
    b.db.prepare("INSERT INTO actions (id, key, kind, project_id, status, started_at) VALUES (?, 'k2', 'system-update', NULL, 'success', ?)").run(hostAction, new Date().toISOString());
    assert.equal((await remoteCall(target.id, { method: "GET", path: `/actions/${projectAction}` }, a)).status, 200);
    assert.equal((await remoteCall(target.id, { method: "GET", path: `/actions/${hostAction}` }, a)).status, 404);
    assert.equal((await remoteCall(target.id, { method: "GET", path: `/actions/${hostAction}/log` }, a)).status, 404);
  } finally { a.close(); await b.stop(); }
});
