import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase, getDatabase, closeDatabase } from "../src/config/database";
import { HealthChecker, type HealthProbe } from "../src/services/healthChecker";
import { createProject } from "../src/services/projectAdmin";
import { addProjectDomain } from "../src/services/projectDomains";
import { updatePushConfig } from "../src/services/webPush";
import { notifySelfUpdateOutcome } from "../src/services/selfUpdate";
import { PushDeliveryWorker } from "../src/services/pushDeliveryWorker";
import { gateOnHealth, getProjectById, recordBlockedDeployAttempt } from "../src/services/projectDeploy";
import { recordSuccessfulDeployment } from "../src/services/projectDeployments";
import { encryptSecret } from "../src/utils/crypto";
import { getPushConfig } from "../src/services/webPush";

beforeEach(() => {
  initializeDatabase();
  getDatabase().exec("DELETE FROM push_deliveries; DELETE FROM push_events; DELETE FROM push_subscriptions; DELETE FROM push_config; DELETE FROM app_meta WHERE key='enqueued_self_update_outcome'");
  updatePushConfig({ enabled: true, subject: "operator@example.com" });
  getDatabase().prepare("INSERT INTO push_subscriptions (endpoint,p256dh,auth,label) VALUES ('https://fcm.googleapis.com/producer','public','auth','Laptop')").run();
});
afterEach(() => mock.restoreAll());
function project(): number {
  const id = createProject({ name: "producer-fixture", sourceType: "upload" }).id;
  addProjectDomain(id, `fixture-${id}.example.com`, true);
  getDatabase().prepare("UPDATE projects SET health_check_endpoint='/health', last_status='up' WHERE id=?").run(id);
  return id;
}
function events(): { event_key: string; event_type: string }[] {
  return getDatabase().prepare("SELECT event_key,event_type FROM push_events ORDER BY id").all() as ReturnType<typeof events>;
}

test("health transition and enqueue are atomic; repeats deduplicate and recovery cancels only that episode", async () => {
  const id = project();
  let status: HealthProbe["status"] = "down";
  const checker = new HealthChecker(async () => {
    assert.equal(getDatabase().inTransaction, false, "network probe must remain outside SQLite transactions");
    return { status, responseMs: 5 };
  });
  await checker.check(id); await checker.check(id);
  assert.equal(events().length, 1);
  const first = events()[0].event_key;
  status = "up"; await checker.check(id);
  assert.equal((getDatabase().prepare("SELECT status FROM push_deliveries").get() as { status: string }).status, "cancelled");
  status = "down"; await checker.check(id);
  assert.equal(events().length, 2);
  assert.notEqual(events()[1].event_key, first);
});

test("enqueue SQL failure cannot commit a DOWN transition without the eligible event", async () => {
  const id = project(); const db = getDatabase();
  const checker = new HealthChecker(async () => ({ status: "down", responseMs: 1 }));
  db.exec("CREATE TEMP TRIGGER producer_fail BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'enqueue failed'); END");
  try {
    await assert.rejects(checker.check(id), /enqueue failed/);
    assert.equal((db.prepare("SELECT last_status FROM projects WHERE id=?").get(id) as { last_status: string }).last_status, "up");
    assert.equal(events().length, 0);
  } finally { db.exec("DROP TRIGGER producer_fail"); }
  await checker.check(id);
  closeDatabase(); initializeDatabase();
  assert.equal(events().length, 1, "committed health incident survives process restart");
});

test("overlapping probes reread authoritative state and produce only one incident", async () => {
  const id = project(); let calls = 0;
  const releases: (() => void)[] = [];
  const probe = async (): Promise<HealthProbe> => {
    calls++; await new Promise<void>((resolve) => releases.push(resolve)); return { status: "down", responseMs: 2 };
  };
  const one = new HealthChecker(probe); const two = new HealthChecker(probe);
  const first = one.check(id); const overlappingLocal = one.check(id); const overlappingProcess = two.check(id);
  assert.equal(calls, 2, "same-process overlapping probe is suppressed");
  releases.splice(0).forEach((resolve) => resolve());
  await Promise.all([first, overlappingLocal, overlappingProcess]);
  assert.equal(events().length, 1);
});

test("paused/deleted/reconfigured projects drop in-flight probe results", async () => {
  for (const mutation of ["UPDATE projects SET paused=1 WHERE id=?", "DELETE FROM projects WHERE id=?", "UPDATE projects SET health_check_endpoint='/other' WHERE id=?"]) {
    const id = project(); let finish!: () => void;
    const checker = new HealthChecker(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { status: "down", responseMs: 2 }; });
    const checking = checker.check(id);
    getDatabase().prepare(mutation).run(id); finish(); await checking;
    assert.equal(events().length, 0);
  }
});

test("an older cross-process probe cannot overwrite a newer healthy result", async () => {
  const id = project(); let finishOld!: () => void;
  const old = new HealthChecker(async () => { await new Promise<void>((resolve) => { finishOld = resolve; }); return { status: "down", responseMs: 3 }; });
  const checking = old.check(id);
  await new HealthChecker(async () => ({ status: "up", responseMs: 1 })).check(id);
  finishOld(); await checking;
  assert.equal((getDatabase().prepare("SELECT last_status FROM projects WHERE id=?").get(id) as { last_status: string }).last_status, "up");
  assert.equal(events().length, 0);
});

test("health incidents observed while disabled are not replayed when enabled", async () => {
  const id = project(); const checker = new HealthChecker(async () => ({ status: "down", responseMs: 1 }));
  updatePushConfig({ enabled: false }); await checker.check(id);
  updatePushConfig({ enabled: true }); await checker.check(id);
  assert.equal(events().length, 0);
});

test("updater marker commits with enqueue and transient delivery remains retryable after restart", async () => {
  const db = getDatabase(); const outcome = { id: "updater-atomic", status: "rolled-back" as const, output: "SECRET_LOG" };
  db.exec("CREATE TEMP TRIGGER updater_fail BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'enqueue failed'); END");
  try {
    await assert.rejects(notifySelfUpdateOutcome(outcome), /enqueue failed/);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='enqueued_self_update_outcome'").get(), undefined);
    assert.equal(events().length, 0);
  } finally { db.exec("DROP TRIGGER updater_fail"); }
  await notifySelfUpdateOutcome(outcome);
  await new PushDeliveryWorker({ send: async () => ({ kind: "retry", code: "push_network_error" }) }).poll();
  closeDatabase(); initializeDatabase();
  await notifySelfUpdateOutcome(outcome);
  assert.equal(events().length, 1);
  assert.equal((getDatabase().prepare("SELECT status FROM push_deliveries").get() as { status: string }).status, "retry");
  assert.ok(!(getDatabase().prepare("SELECT payload_json FROM push_events").get() as { payload_json: string }).payload_json.includes("SECRET_LOG"));
});

test("blocked attempt and unhealthy revision commit with their durable event, keyed by persisted attempt", async () => {
  const id = project(); const db = getDatabase(); const source = getProjectById(id)!;
  const input = { commitSha: "a".repeat(40), branch: "main", composeFileName: "compose.yml", triggeredBy: "auto" };
  db.exec("CREATE TEMP TRIGGER deployment_fail BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'enqueue failed'); END");
  try {
    assert.throws(() => recordBlockedDeployAttempt(source, input, "SECRET_REASON", true), /enqueue failed/);
    assert.equal(db.prepare("SELECT id FROM project_deployments WHERE project_id=?").get(id), undefined);
  } finally { db.exec("DROP TRIGGER deployment_fail"); }
  const attempt = recordBlockedDeployAttempt(source, input, "SECRET_REASON", true);
  assert.equal(events()[0].event_key, `deploy_blocked:${id}:${attempt}`);
  recordSuccessfulDeployment(id, { ...input, sourceCompose: "services: {}", effectiveCompose: "services: {}" });
  let clock = 0;
  const deps = { probe: async () => ({ status: "down" as const, responseMs: 1 }), now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  db.exec("CREATE TEMP TRIGGER unhealthy_fail BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'enqueue failed'); END");
  try {
    await assert.rejects(gateOnHealth(source, "deploy", input.commitSha, false, deps), /enqueue failed/);
    assert.equal((db.prepare("SELECT health_failed_at FROM project_deployments WHERE project_id=? AND status='active'").get(id) as { health_failed_at: string | null }).health_failed_at, null);
  } finally { db.exec("DROP TRIGGER unhealthy_fail"); }
  await gateOnHealth(source, "deploy", input.commitSha, false, deps);
  await gateOnHealth(source, "deploy", input.commitSha, false, deps);
  assert.equal(events().filter((event) => event.event_type === "deploy_unhealthy").length, 1);
});

test("blocked deployment email is sent only after the attempt transaction commits", async () => {
  const id = project(); const db = getDatabase(); const source = getProjectById(id)!;
  const credential = db.prepare("INSERT INTO credentials (type,alias,secret_enc) VALUES ('api_key','blocked-email',?)").run(encryptSecret("test-api-key"));
  db.prepare(`INSERT OR REPLACE INTO notification_config
    (id,enabled,provider,credential_id,from_address,to_address) VALUES (1,1,'mw',?,'from@example.com','to@example.com')`).run(credential.lastInsertRowid);
  let emails = 0;
  mock.method(globalThis, "fetch", async () => {
    assert.equal(db.inTransaction, false);
    assert.ok(db.prepare("SELECT id FROM project_deployments WHERE project_id=?").get(id));
    assert.equal(events().length, 1);
    emails++; return new Response("{}", { status: 200 });
  });
  const input = { commitSha: "b".repeat(40), branch: "main", composeFileName: "compose.yml", triggeredBy: "auto" };
  db.exec("CREATE TEMP TRIGGER blocked_email_fail BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'enqueue failed'); END");
  try {
    assert.throws(() => recordBlockedDeployAttempt(source, input, "blocked", true), /enqueue failed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(emails, 0);
  } finally { db.exec("DROP TRIGGER blocked_email_fail"); }
  recordBlockedDeployAttempt(source, input, "blocked", true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emails, 1);
  db.exec("DELETE FROM notification_config");
});

test("automatic rollback recovery is opt-in and preserves the initial immutable incident", async () => {
  assert.equal(getPushConfig().events.rollback_recovered, false);
  for (const enabled of [false, true]) {
    updatePushConfig({ events: { rollback_recovered: enabled } });
    const id = project(); const source = { ...getProjectById(id)!, autoRollbackUnhealthy: true };
    let clock = 0; let initialPayload = "";
    const deps = { probe: async () => ({ status: "down" as const, responseMs: 1 }), now: () => clock, sleep: async (ms: number) => { clock += ms; } };
    await gateOnHealth(source, "deploy", null, true, deps, undefined, async () => {
      initialPayload = (getDatabase().prepare("SELECT payload_json FROM push_events WHERE project_id=?").get(id) as { payload_json: string }).payload_json;
      return { ok: true, projectId: id, repoPath: "", output: "Restored", action: "deploy" };
    });
    const rows = getDatabase().prepare("SELECT event_type,payload_json FROM push_events WHERE project_id=? ORDER BY id").all(id) as { event_type: string; payload_json: string }[];
    assert.equal(rows[0].event_type, "deploy_unhealthy");
    assert.equal(rows[0].payload_json, initialPayload);
    assert.equal(rows.length, enabled ? 2 : 1);
    if (enabled) {
      assert.equal(rows[1].event_type, "rollback_recovered");
      assert.match(rows[1].payload_json, /previous version and its health check passed/);
      assert.notEqual(JSON.parse(rows[0].payload_json).eventKey, JSON.parse(rows[1].payload_json).eventKey);
    }
  }
});

test("failed or throwing automatic rollback emits only a failure follow-up", async () => {
  updatePushConfig({ events: { rollback_recovered: true } });
  for (const throws of [false, true]) {
    const id = project(); const source = { ...getProjectById(id)!, autoRollbackUnhealthy: true };
    let clock = 0;
    const deps = { probe: async () => ({ status: "down" as const, responseMs: 1 }), now: () => clock, sleep: async (ms: number) => { clock += ms; } };
    await gateOnHealth(source, "deploy", null, true, deps, undefined, async () => {
      if (throws) throw new Error("rollback failed");
      return { ok: false, projectId: id, repoPath: "", output: "Failed", action: "deploy" };
    });
    assert.deepEqual(getDatabase().prepare("SELECT event_type FROM push_events WHERE project_id=? ORDER BY id").all(id),
      [{ event_type: "deploy_unhealthy" }, { event_type: "rollback_failed" }]);
  }
});
