import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { config } from "../src/config/env";
import { createProject } from "../src/modules/projects/operations";
import { getPushConfig, updatePushConfig } from "../src/modules/notifications/push/transport";
import { cancelDisabledDeliveries, cancelEvent, cancelSubscriptionDeliveries, claimDueDeliveries, cleanupOldEvents,
  enqueuePushEvent, enqueuePushEventTx, finishDelivery, getPushQueueStatus, leaseIsEligible, PUSH_LEASE_MS } from "../src/modules/notifications/push/outbox";
import type { DurablePushEvent } from "../src/modules/notifications/types";

const now = Date.parse("2026-11-03T20:00:00Z");
const event = (key = "deploy_unhealthy:1:one"): DurablePushEvent => ({ eventKey: key, type: "deploy_unhealthy", severity: "error",
  title: "App unhealthy", body: "Open Stackport for details.", url: "/projects/1", createdAt: new Date(now).toISOString() });
function browser(label = "Laptop"): number {
  return Number(getDatabase().prepare("INSERT INTO push_subscriptions (endpoint,p256dh,auth,label) VALUES (?, 'public','auth',?)")
    .run(`https://fcm.googleapis.com/${label}`, label).lastInsertRowid);
}
beforeEach(() => {
  initializeDatabase();
  getDatabase().exec("DELETE FROM push_deliveries; DELETE FROM push_events; DELETE FROM push_subscriptions; DELETE FROM push_config;");
  getPushConfig(); updatePushConfig({ enabled: true, subject: "operator@example.com" });
});

test("enqueue snapshots browsers once and deduplicates an incident, with no secret fields in payload", () => {
  const db = getDatabase(); browser(); browser("Phone");
  const first = enqueuePushEvent(db, event(), now);
  browser("Later");
  assert.deepEqual(enqueuePushEvent(db, event(), now), { eventId: first.eventId, inserted: false });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM push_deliveries").get() as { n: number }).n, 2);
  const payload = JSON.parse((db.prepare("SELECT payload_json FROM push_events").get() as { payload_json: string }).payload_json);
  assert.equal(payload.version, 1);
  assert.equal(payload.tag, event().eventKey);
  assert.deepEqual(Object.keys(payload).sort(), ["version", "eventKey", "title", "body", "url", "tag", "createdAt"].sort());
});

test("failed recipient insertion rolls back the event and its domain change", () => {
  const db = getDatabase(); browser();
  db.exec("CREATE TEMP TRIGGER fail_enqueue BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT, 'forced write failure'); END");
  try {
    assert.throws(() => db.transaction(() => {
      db.prepare("INSERT INTO app_meta (key,value) VALUES ('outbox_rollback_fixture','down')").run();
      enqueuePushEventTx(db, event(), now);
    })(), /forced write failure/);
    assert.equal(db.prepare("SELECT id FROM push_events").get(), undefined);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='outbox_rollback_fixture'").get(), undefined);
  } finally { db.exec("DROP TRIGGER fail_enqueue"); }
});

test("disabled events and absent recipients do not backfill newly registered browsers", () => {
  const db = getDatabase();
  assert.equal(enqueuePushEvent(db, event(), now).eventId, null);
  browser(); updatePushConfig({ enabled: false });
  assert.equal(enqueuePushEvent(db, event(), now).eventId, null);
  updatePushConfig({ enabled: true });
  assert.equal(claimDueDeliveries(db, now).length, 0);
  updatePushConfig({ events: { deploy_unhealthy: false } });
  assert.equal(enqueuePushEvent(db, event(), now).eventId, null);
});

test("enqueue validates bounded keys, lifetime and internal navigation", () => {
  const db = getDatabase(); browser();
  for (const url of ["//evil.example/", "https://evil.example/", "/api/private", "/\\evil.example/"]) {
    assert.throws(() => enqueuePushEvent(db, { ...event(), url }, now), /navigation/);
  }
  assert.throws(() => enqueuePushEvent(db, { ...event(), eventKey: "x".repeat(500) }, now), /identity/);
  assert.throws(() => enqueuePushEvent(db, { ...event(), createdAt: "invalid" }, now), /lifetime/);
  assert.equal(enqueuePushEvent(db, event(), now + 13 * 3_600_000).eventId, null);
});

test("two SQLite connections cannot claim a live lease; stale completion cannot overwrite a recovered lease", () => {
  const db = getDatabase(); browser(); enqueuePushEvent(db, event(), now);
  const second = new Database(config.sqlitePath);
  second.pragma("foreign_keys = ON");
  try {
    const [old] = claimDueDeliveries(db, now);
    assert.equal(old.attempts, 1);
    assert.equal(claimDueDeliveries(second, now + 1).length, 0);
    const [recovered] = claimDueDeliveries(second, now + PUSH_LEASE_MS + 1);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(old.lease_token, recovered.lease_token);
    assert.equal(finishDelivery(db, old, "accepted", {}, now + PUSH_LEASE_MS + 2), false);
    assert.equal(finishDelivery(second, recovered, "accepted", {}, now + PUSH_LEASE_MS + 3), true);
    assert.equal(claimDueDeliveries(db, now + 2 * PUSH_LEASE_MS).length, 0);
  } finally { second.close(); }
});

test("reopen recovers pending work and a crash after provider acceptance can submit again", () => {
  browser(); enqueuePushEvent(getDatabase(), event(), now);
  closeDatabase(); initializeDatabase();
  const [first] = claimDueDeliveries(getDatabase(), now);
  // Simulated provider acceptance, then process crash before SQLite completion.
  closeDatabase(); initializeDatabase();
  const [retry] = claimDueDeliveries(getDatabase(), now + PUSH_LEASE_MS + 1);
  assert.equal(first.event_key, retry.event_key);
  assert.equal(retry.attempts, 2);
});

test("disable and removal cancel leased work without letting late acceptance resurrect it", () => {
  const db = getDatabase(); const id = browser(); enqueuePushEvent(db, event(), now);
  const [lease] = claimDueDeliveries(db, now);
  cancelSubscriptionDeliveries(db, id, now + 1);
  assert.equal(finishDelivery(db, lease, "accepted", {}, now + 2), false);
  enqueuePushEvent(db, event("deploy_unhealthy:1:two"), now);
  updatePushConfig({ enabled: false }); cancelDisabledDeliveries(db, now + 3);
  updatePushConfig({ enabled: true });
  assert.equal(claimDueDeliveries(db, now + 4).length, 0);
});

test("health eligibility checks the same incident, while historical deploy failures remain relevant", () => {
  const db = getDatabase(); browser();
  const project = createProject({ name: "outbox-health", sourceType: "upload" });
  const health: DurablePushEvent = { ...event(`health_check:${project.id}:episode`), type: "health_check", projectId: project.id };
  db.prepare("UPDATE projects SET last_status='down', health_incident_key=? WHERE id=?").run(health.eventKey, project.id);
  enqueuePushEvent(db, health, now);
  const [lease] = claimDueDeliveries(db, now);
  assert.equal(leaseIsEligible(db, lease, now), true);
  db.prepare("UPDATE projects SET last_status='up', health_incident_key=NULL WHERE id=?").run(project.id);
  assert.equal(leaseIsEligible(db, lease, now), false);
  enqueuePushEvent(db, event(), now);
  assert.equal(leaseIsEligible(db, claimDueDeliveries(db, now)[0], now), true);
});

test("event cancellation and expiry terminate unsent work", () => {
  const db = getDatabase(); browser(); enqueuePushEvent(db, event(), now);
  cancelEvent(db, event().eventKey, "resolved", now + 1);
  assert.equal(claimDueDeliveries(db, now + 2).length, 0);
  enqueuePushEvent(db, event("deploy_unhealthy:1:expired"), now);
  assert.equal(claimDueDeliveries(db, now + 13 * 3_600_000).length, 0);
  assert.equal((db.prepare("SELECT status FROM push_deliveries ORDER BY id DESC LIMIT 1").get() as { status: string }).status, "expired");
});

test("bounded retention removes old terminal events, never live work", () => {
  const db = getDatabase(); browser();
  for (let index = 0; index < 4; index++) enqueuePushEvent(db, event(`deploy_unhealthy:1:${index}`), now);
  const leases = claimDueDeliveries(db, now);
  finishDelivery(db, leases[0], "accepted", {}, now);
  finishDelivery(db, leases[1], "retry", { nextAttemptAt: now + 1000 }, now);
  db.prepare("UPDATE push_deliveries SET status='pending' WHERE id=?").run(leases[2].id);
  assert.equal(cleanupOldEvents(db, now + 31 * 86_400_000, 1), 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM push_events").get() as { n: number }).n, 3);
  assert.equal(getPushQueueStatus(db, now).leased, 1);
});
