import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/services/projectAdmin";
import { recordFailedDeployment, recordSuccessfulDeployment, resolveRollbackTarget } from "../src/services/projectDeployments";

before(() => { initializeDatabase(); });

let counter = 0;
function project(): number {
  return createProject({ name: `rollback-${++counter}`, sourceType: "github", githubRepo: "o/r" }).id;
}

function deploy(projectId: number, sha: string, opts: { rollback?: boolean } = {}): void {
  recordSuccessfulDeployment(projectId, {
    commitSha: sha,
    branch: "main",
    composeFileName: "docker-compose.yml",
    sourceCompose: `# ${sha}`,
    effectiveCompose: `# ${sha}`,
    triggeredBy: "manual",
  }, opts);
}

function targetSha(projectId: number, deploymentId?: number): string | null {
  const result = resolveRollbackTarget(projectId, deploymentId);
  return result.ok ? result.target.commitSha : null;
}

test("default rollback picks the previous revision", () => {
  const id = project();
  deploy(id, "aaaaaaa");
  deploy(id, "bbbbbbb");
  assert.equal(targetSha(id), "aaaaaaa");
});

test("rolling back twice keeps going back instead of returning to the broken revision", () => {
  const id = project();
  deploy(id, "aaaaaaa");
  deploy(id, "bbbbbbb");
  deploy(id, "ccccccc"); // broken
  assert.equal(targetSha(id), "bbbbbbb");
  deploy(id, "bbbbbbb", { rollback: true }); // rollback C -> B
  // Candidates now: C (rolled back from: skipped), B (same as running: skipped), A.
  assert.equal(targetSha(id), "aaaaaaa");
});

test("a deploy after a rollback makes the rolled-back-to revision the default target", () => {
  const id = project();
  deploy(id, "aaaaaaa");
  deploy(id, "bbbbbbb");
  deploy(id, "aaaaaaa", { rollback: true });
  deploy(id, "ddddddd");
  assert.equal(targetSha(id), "aaaaaaa");
});

test("revisions created within the same second are still ordered", () => {
  const id = project();
  // created_at has one-second resolution, so these usually share a timestamp.
  for (const sha of ["1111111", "2222222", "3333333", "4444444"]) deploy(id, sha);
  assert.equal(targetSha(id), "3333333");
});

test("failed deploys are never a rollback target", () => {
  const id = project();
  deploy(id, "aaaaaaa");
  deploy(id, "bbbbbbb");
  recordFailedDeployment(id, { commitSha: "ccccccc", branch: "main", composeFileName: "docker-compose.yml", triggeredBy: "auto" }, "build failed");
  assert.equal(targetSha(id), "aaaaaaa");
});

test("with only one revision there is nothing to roll back to", () => {
  const id = project();
  deploy(id, "aaaaaaa");
  const result = resolveRollbackTarget(id);
  assert.equal(result.ok, false);
});

test("an explicit target may be a revision rolled back from, but not the running one", () => {
  const id = project();
  deploy(id, "aaaaaaa");
  deploy(id, "bbbbbbb");
  deploy(id, "aaaaaaa", { rollback: true });
  assert.equal(resolveRollbackTarget(id).ok, false, "B is rolled back from and A is running: no default target");

  const pickB = resolveRollbackTarget(id, idOf(id, "bbbbbbb"));
  assert.equal(pickB.ok && pickB.target.commitSha, "bbbbbbb", "picking B explicitly is allowed");
  assert.equal(resolveRollbackTarget(id, idOf(id, "aaaaaaa", "active")).ok, false, "the running revision can't be restored");
});

test("an explicit target from another project is rejected", () => {
  const a = project();
  deploy(a, "aaaaaaa");
  deploy(a, "bbbbbbb");
  const b = project();
  deploy(b, "ccccccc");
  deploy(b, "ddddddd");
  assert.equal(resolveRollbackTarget(b, idOf(a, "aaaaaaa")).ok, false);
});

function idOf(projectId: number, sha: string, status = "superseded"): number {
  const row = getDatabase()
    .prepare("SELECT id FROM project_deployments WHERE project_id = ? AND commit_sha = ? AND status = ? ORDER BY id DESC LIMIT 1")
    .get(projectId, sha, status) as { id: number };
  return row.id;
}
