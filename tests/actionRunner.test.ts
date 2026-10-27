import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { encryptSecret } from "../src/utils/crypto";
import { createProject } from "../src/services/projectAdmin";
import { createProjectEnvFile } from "../src/services/projectDeploy";
import { actionRegistry, markInterruptedActions, type OutputChunk } from "../src/services/actionRegistry";
import { actionLogPath, deleteProjectActionLogs, LOG_KEEP_PER_KEY, pruneActionLogs, readActionLog } from "../src/services/actionLog";
import { issueAuthToken } from "../src/services/authTokens";
import app from "../src/app";

const CREDENTIAL_SECRET = "ghp_credential_secret_value";
const ENV_SECRET = "env-secret-value-42";

let projectId: number;

before(() => {
  initializeDatabase();
  projectId = createProject({ name: "runner", sourceType: "github", githubRepo: "o/r" }).id;
  createProjectEnvFile(projectId, ".env", [{ key: "TOKEN", value: ENV_SECRET }]);
  getDatabase().prepare("INSERT INTO credentials (type, alias, secret_enc) VALUES ('github', 'runner-gh', ?)").run(encryptSecret(CREDENTIAL_SECRET));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts an action on `key` that runs until the returned `finish` is called. */
function start(key: string, kind = "deploy", meta: Record<string, unknown> = { projectId }) {
  let resolve!: (r: { ok: boolean; output?: string }) => void;
  const record = actionRegistry.tryStart(key, kind, meta, () => new Promise((r) => { resolve = r; }))!;
  assert.ok(record, "action started");
  return {
    record,
    finish: async (ok = true, output?: string) => { resolve({ ok, output }); await wait(20); },
  };
}

function row(id: string) {
  return getDatabase().prepare("SELECT * FROM actions WHERE id = ?").get(id) as Record<string, unknown>;
}

test("an action is recorded when it starts and when it finishes", async () => {
  const run = start("test:persist", "deploy", { projectId, triggeredBy: "webhook", commitSha: "abc1234" });
  assert.equal(row(run.record.id).status, "running");
  assert.equal(row(run.record.id).triggered_by, "webhook");
  assert.equal(row(run.record.id).commit_sha, "abc1234");
  await run.finish(true);
  assert.equal(row(run.record.id).status, "success");
  assert.ok(row(run.record.id).finished_at);
});

test("output is numbered, masked, batched, and written to a private log file", async () => {
  const chunks: OutputChunk[] = [];
  const off = actionRegistry.onOutput((record, chunk) => { if (record.key === "test:output") chunks.push(chunk); });
  const run = start("test:output");
  actionRegistry.append("test:output", `token=${CREDENTIAL_SECRET}\n`);
  actionRegistry.append("test:output", `env ${ENV_SECRET}\n`);
  await wait(150);
  actionRegistry.append("test:output", "second batch\n");
  await run.finish(true);
  off();

  assert.deepEqual(chunks.map((c) => c.seq), [0, 1]);
  const text = chunks.map((c) => c.data).join("");
  assert.equal(text, "token=***\nenv ***\nsecond batch\n");
  const file = readActionLog(run.record.id)!;
  assert.equal(file, text);
  assert.equal(fs.statSync(actionLogPath(run.record.id)).mode & 0o777, 0o600);
  assert.equal(run.record.log, text, "the record's log is the masked stream too");
});

test("a secret split across two writes is still masked", async () => {
  const run = start("test:split");
  actionRegistry.append("test:split", `value=${ENV_SECRET.slice(0, 7)}`);
  await wait(150);
  actionRegistry.append("test:split", `${ENV_SECRET.slice(7)} done\n`);
  await run.finish(true);
  assert.equal(readActionLog(run.record.id), "value=*** done\n");
});

test("a partial line is held back briefly, then shown", async () => {
  const chunks: OutputChunk[] = [];
  const off = actionRegistry.onOutput((record, chunk) => { if (record.key === "test:partial") chunks.push(chunk); });
  const run = start("test:partial");
  actionRegistry.append("test:partial", "Password: ");
  await wait(300);
  assert.equal(chunks.length, 0, "held back while waiting for the rest of the line");
  await wait(1000);
  assert.equal(chunks.map((c) => c.data).join(""), "Password: ");
  await run.finish(true);
  off();
});

test("actions without streamed output log their final output", async () => {
  const run = start("test:final", "nginx-apply", {});
  await run.finish(false, `nginx: [emerg] bad config ${CREDENTIAL_SECRET}`);
  assert.equal(readActionLog(run.record.id), "nginx: [emerg] bad config ***");
  assert.equal(row(run.record.id).status, "failed");
});

test("replay sends the chunks after fromSeq, or the whole log once they're gone", async () => {
  const run = start("test:replay");
  for (const line of ["a\n", "b\n", "c\n"]) {
    actionRegistry.append("test:replay", line);
    await wait(150);
  }
  const fromOne = actionRegistry.replay(run.record.id, 1)!;
  assert.deepEqual(fromOne.chunks.map((c) => c.data), ["b\n", "c\n"]);
  assert.equal(fromOne.nextSeq, 3);
  assert.equal(fromOne.done, false);
  await run.finish(true);

  // A newer action on the same key drops the old one's in-memory output.
  const next = start("test:replay");
  const old = actionRegistry.replay(run.record.id, 0)!;
  assert.equal(old.reset, "a\nb\nc\n");
  assert.equal(old.done, true);
  await next.finish(true);
});

test("annotate fills in commit details without overwriting them", async () => {
  const run = start("test:annotate", "deploy", { projectId, commitSha: "first" });
  actionRegistry.annotate("test:annotate", { commitSha: "second", branch: "main" });
  assert.equal(row(run.record.id).commit_sha, "first");
  assert.equal(row(run.record.id).branch, "main");
  await run.finish(true);
});

test("actions left running by a previous process are marked interrupted", () => {
  getDatabase().prepare("INSERT INTO actions (id, key, kind, status, started_at) VALUES ('legacy-9001', 'k', 'deploy', 'running', ?)").run(new Date().toISOString());
  assert.ok(markInterruptedActions() >= 1);
  assert.equal(row("legacy-9001").status, "interrupted");
});

test("retention keeps the newest log files per key and deletes old ones", async () => {
  const ids: string[] = [];
  for (let i = 0; i < LOG_KEEP_PER_KEY + 3; i++) {
    const run = start("test:retention");
    actionRegistry.append("test:retention", `run ${i}\n`);
    await run.finish(true);
    ids.push(run.record.id);
    // started_at must differ for ordering; ISO strings have millisecond resolution.
    await wait(2);
  }
  pruneActionLogs();
  const kept = ids.filter((id) => fs.existsSync(actionLogPath(id)));
  assert.equal(kept.length, LOG_KEEP_PER_KEY);
  assert.deepEqual(kept, ids.slice(3), "the oldest three are gone");
  assert.equal(row(ids[0]).log_path, null);
  assert.ok(row(ids[0]), "the row itself stays for Insights");

  // Age limit: an old finished action loses its log even if it's among the newest.
  getDatabase().prepare("UPDATE actions SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), ids.at(-1));
  pruneActionLogs();
  assert.equal(fs.existsSync(actionLogPath(ids.at(-1)!)), false);
});

test("a project's logs can be deleted, keeping its history", async () => {
  const run = start("test:delete", "deploy", { projectId });
  actionRegistry.append("test:delete", "x\n");
  await run.finish(true);
  assert.ok(deleteProjectActionLogs(projectId) >= 1);
  assert.equal(fs.existsSync(actionLogPath(run.record.id)), false);
  assert.equal(row(run.record.id).status, "success");
});

test("Recent deploys lists deploy-type actions from the action log", async () => {
  const run = start(`project:${projectId}:repo`, "rollback", { projectId });
  await run.finish(true);
  const other = start(`project:${projectId}:ssl:1`, "ssl-issue", { projectId });
  await other.finish(true);

  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/deploys`, {
      headers: { authorization: `Bearer ${issueAuthToken("admin")}` },
    });
    const deploys = await res.json() as { id: string; kind: string }[];
    assert.ok(deploys.some((d) => d.id === run.record.id && d.kind === "rollback"));
    assert.equal(deploys.some((d) => d.id === other.record.id), false, "SSL issuance isn't a deploy");
  } finally {
    server.close();
  }
});

test("existing auto-deploy history is copied into the action log", () => {
  const db = getDatabase();
  db.exec("DROP TABLE actions");
  db.pragma("user_version = 3");
  db.prepare("INSERT INTO project_deploys (project_id, commit_sha, triggered_by, status, created_at, completed_at) VALUES (?, 'old1', 'auto', 'success', '2026-09-01T10:00:00.000Z', '2026-09-01T10:05:00.000Z')").run(projectId);
  db.prepare("INSERT INTO project_deploys (project_id, commit_sha, triggered_by, status, created_at) VALUES (?, 'old2', 'webhook', 'running', '2026-09-02T10:00:00.000Z')").run(projectId);
  closeDatabase();
  initializeDatabase();
  const rows = getDatabase().prepare("SELECT commit_sha, status, triggered_by, kind FROM actions WHERE id LIKE 'legacy-%' AND commit_sha LIKE 'old%' ORDER BY commit_sha").all();
  assert.deepEqual(rows, [
    { commit_sha: "old1", status: "success", triggered_by: "auto", kind: "deploy" },
    { commit_sha: "old2", status: "interrupted", triggered_by: "webhook", kind: "deploy" },
  ]);
});

after(() => { closeDatabase(); });
