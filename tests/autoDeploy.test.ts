import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/services/projectAdmin";
import { actionRegistry, projectRepoKey } from "../src/services/actionRegistry";
import { clearPendingAutoDeploy, requestAutoDeploy, resetPendingAutoDeploys } from "../src/services/autoDeploy";

const commit = (sha: string) => ({ sha, commitMessage: `commit ${sha}`, commitAuthor: "dev", commitAt: null });

function row(projectId: number) {
  return getDatabase().prepare("SELECT pending_deploy_sha, last_commit_sha FROM projects WHERE id = ?").get(projectId) as { pending_deploy_sha: string | null; last_commit_sha: string | null };
}

/** Occupies the project's action slot until the returned function is called. */
function holdSlot(projectId: number): () => void {
  let release!: () => void;
  actionRegistry.tryStart(projectRepoKey(projectId), "build", { projectId }, () => new Promise((resolve) => {
    release = () => resolve({ ok: true, output: "" });
  }));
  return release;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

before(() => { initializeDatabase(); });

test("pushes during a running action coalesce to the newest commit", () => {
  const { id } = createProject({ name: "coalesce", sourceType: "github", githubRepo: "o/r" });
  const release = holdSlot(id);
  assert.equal(requestAutoDeploy(id, commit("aaa"), "auto"), "queued");
  assert.equal(requestAutoDeploy(id, commit("bbb"), "webhook"), "queued");
  assert.equal(row(id).pending_deploy_sha, "bbb");
  assert.equal(row(id).last_commit_sha, null, "nothing counts as deployed until it starts");
  clearPendingAutoDeploy(id);
  release();
});

test("a queued deploy is dropped when the project is paused before the slot frees", async () => {
  const { id } = createProject({ name: "paused", sourceType: "github", githubRepo: "o/r" });
  const release = holdSlot(id);
  requestAutoDeploy(id, commit("ccc"), "auto");
  getDatabase().prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(id);
  release();
  await settle(); await settle();
  assert.equal(row(id).pending_deploy_sha, null);
  assert.equal(actionRegistry.get(projectRepoKey(id))?.kind, "build", "no deploy may start for a paused project");
});

test("switching to manual drops the queued deploy too", async () => {
  const { id } = createProject({ name: "manual", sourceType: "github", githubRepo: "o/r" });
  const release = holdSlot(id);
  requestAutoDeploy(id, commit("ddd"), "auto");
  getDatabase().prepare("UPDATE projects SET deploy_trigger = 'manual' WHERE id = ?").run(id);
  release();
  await settle(); await settle();
  assert.equal(row(id).pending_deploy_sha, null);
});

test("a restart clears stale queue markers", () => {
  const { id } = createProject({ name: "restart", sourceType: "github", githubRepo: "o/r" });
  getDatabase().prepare("UPDATE projects SET pending_deploy_sha = 'eee' WHERE id = ?").run(id);
  resetPendingAutoDeploys();
  assert.equal(row(id).pending_deploy_sha, null);
});
