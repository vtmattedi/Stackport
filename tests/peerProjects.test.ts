import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import Database from "better-sqlite3";
import migration from "../src/migrations/021_peers";
import { ensureInstanceIdentity, setInstanceName } from "../src/modules/backup/instance";
import { parseLogQuery } from "../src/modules/deployments/logQuery";
import { issuePairingCode, registerTarget, remoteGet, PeerError } from "../src/modules/peers/service";
import { getControllerByInstance, revokeController } from "../src/modules/peers/store";

/** B is this process's real application (real database, real routes, real control router); A is a bare in-memory controller, as another host would be. */
async function startB(): Promise<{ server: Server; url: string; db: Database.Database; stop: () => Promise<void> }> {
  const { default: app } = await import("../src/app");
  const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/config/database");
  initializeDatabase();
  const db = getDatabase();
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return {
    server, db, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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

test("a controller with projects:read sees the peer's projects, status, domains, history and logs; nothing it was not given", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    b.db.prepare("INSERT INTO projects (name, source_type, github_repo, auto_deploy_branch, credential_id, hook_secret_enc) VALUES ('Shop', 'github', 'acme/shop', 'main', NULL, 'SECRET-ENC')").run();
    const projectId = (b.db.prepare("SELECT id FROM projects WHERE name = 'Shop'").get() as { id: number }).id;
    b.db.prepare("INSERT INTO project_domains (project_id, domain) VALUES (?, 'shop.example.com')").run(projectId);

    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    const target = await registerTarget(code, a);

    const list = await remoteGet<{ projects: { id: number; name: string; status: { state: string } | null; domains: { domain: string }[] }[] }>(target.id, "/control/v1/projects", {}, a);
    assert.equal(list.stale, false);
    assert.equal(list.data.projects.length, 1);
    assert.equal(list.data.projects[0].name, "Shop");
    assert.ok(list.data.projects[0].status, "the status the live stream reports");
    assert.deepEqual(list.data.projects[0].domains.map((d) => d.domain), ["shop.example.com"]);
    assert.ok(!JSON.stringify(list.data).includes("SECRET-ENC"), "no stored secret is part of the answer");
    assert.ok(!("credentialId" in list.data.projects[0]) && !("hookSecret" in list.data.projects[0]));

    const detail = await remoteGet<{ id: number; healthCheck: unknown }>(target.id, `/control/v1/projects/${projectId}`, {}, a);
    assert.equal(detail.data.id, projectId);
    assert.ok(detail.data.healthCheck);

    const deploys = await remoteGet<{ deploys: unknown[] }>(target.id, `/control/v1/projects/${projectId}/deploys`, {}, a);
    assert.deepEqual(deploys.data.deploys, []);

    await assert.rejects(remoteGet(target.id, "/control/v1/projects/9999", {}, a), (e: PeerError) => e.status === 404);
    await assert.rejects(remoteGet(target.id, "/control/v1/projects/abc", {}, a), (e: PeerError) => e.status === 400 || e.status === 502);
  } finally { a.close(); await b.stop(); }
});

test("a controller without projects:read is refused by the peer", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    const target = await registerTarget(code, a);
    // Every current grant includes read, so take it away the way a narrower grant (or an edit of the record) would.
    b.db.prepare("UPDATE peer_controllers SET grants = '' WHERE instance_id = ?").run(ensureInstanceIdentity(a).id);
    await assert.rejects(remoteGet(target.id, "/control/v1/projects", {}, a), (e: PeerError) => e.status === 403 && e.code === "forbidden");
  } finally { a.close(); await b.stop(); }
});

test("an unreachable peer keeps showing what it last said, marked stale; logs are never kept; a revoked peer is not served from memory", async () => {
  const b = await startB();
  const a = controller("Alpha");
  try {
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    const target = await registerTarget(code, a);
    const first = await remoteGet<{ projects: unknown[] }>(target.id, "/control/v1/projects", {}, a);
    assert.equal(first.stale, false);

    // Revoked on the peer: an error, never the cached answer.
    revokeController((getControllerByInstance(ensureInstanceIdentity(a).id, b.db) as { id: number }).id, b.db);
    await assert.rejects(remoteGet(target.id, "/control/v1/projects", {}, a), (e: PeerError) => e.code === "peer-revoked");
  } finally { a.close(); await b.stop(); }

  // The peer is gone now (its server stopped): the next read is an error for a call that was never cached ...
  const a2 = controller("Gamma");
  const b2 = await startB();
  try {
    const { code } = issuePairingCode({ endpoint: b2.url, grants: ["projects:read"] }, b2.db);
    const target = await registerTarget(code, a2);
    const warm = await remoteGet<{ projects: unknown[] }>(target.id, "/control/v1/projects", {}, a2);
    await remoteGet(target.id, `/control/v1/projects/1/logs?tail=10`, { cache: false }, a2).catch(() => undefined);
    await b2.stop();
    // ... and a cached one comes back stale.
    const stale = await remoteGet<{ projects: unknown[] }>(target.id, "/control/v1/projects", {}, a2);
    assert.equal(stale.stale, true);
    assert.equal(stale.fetchedAt, warm.fetchedAt);
    await assert.rejects(remoteGet(target.id, "/control/v1/projects/1/logs?tail=10", { cache: false }, a2), (e: PeerError) => e.code === "unreachable");
  } finally { a2.close(); }
});

test("a refusal ends the stale fallback: a peer that revoked this instance is not shown from memory when it later goes quiet", async () => {
  const a = controller("Alpha");
  const b = await startB();
  try {
    const { code } = issuePairingCode({ endpoint: b.url, grants: ["projects:read"] }, b.db);
    const target = await registerTarget(code, a);
    await remoteGet(target.id, "/control/v1/projects", {}, a); // warms the fallback
    revokeController((getControllerByInstance(ensureInstanceIdentity(a).id, b.db) as { id: number }).id, b.db);
    await assert.rejects(remoteGet(target.id, "/control/v1/projects", {}, a), (e: PeerError) => e.code === "peer-revoked");
    await b.stop();
    await assert.rejects(remoteGet(target.id, "/control/v1/projects", {}, a), (e: PeerError) => e.code === "unreachable", "not the old list, marked stale");
  } finally { a.close(); }
});

test("a service name that could be read as an option is refused, and the line count is bounded", () => {
  assert.equal(parseLogQuery({ service: "--follow" }), null);
  assert.equal(parseLogQuery({ service: "-f" }), null);
  assert.equal(parseLogQuery({ service: "web; rm" }), null);
  assert.deepEqual(parseLogQuery({ service: "web-1", tail: "5000" }), { tail: 1000, service: "web-1" });
  assert.deepEqual(parseLogQuery({ tail: "1" }), { tail: 10, service: undefined });
  assert.deepEqual(parseLogQuery({}), { tail: 100, service: undefined });
});
