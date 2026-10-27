import { getDatabase } from "../config/database";
import { rowToProject, type ProjectRow } from "../entities/Project";
import { deployProject } from "./projectDeploy";
import { emitProjectDataUpdate } from "./realtime";
import { actionRegistry, projectRepoKey } from "./actionRegistry";

export interface AutoDeployCommit {
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAt: string | null;
}

/** What asked for the deploy; stored as actions.triggered_by. */
export type AutoDeploySource = "auto" | "webhook";

export type AutoDeployOutcome = "started" | "queued";

/** Newest commit waiting per project while another action holds its slot. Only the
 *  latest is kept: five pushes during one deploy lead to one more deploy, not five. */
const pending = new Map<number, { commit: AutoDeployCommit; source: AutoDeploySource }>();

function emitProject(projectId: number): void {
  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (row) emitProjectDataUpdate(projectId, rowToProject(row));
}

function recordCommit(projectId: number, commit: AutoDeployCommit): void {
  getDatabase().prepare(
    "UPDATE projects SET last_commit_sha = ?, last_commit_message = ?, last_commit_author = ?, last_commit_at = ?, pending_deploy_sha = NULL WHERE id = ?"
  ).run(commit.sha, commit.commitMessage, commit.commitAuthor, commit.commitAt, projectId);
}

function start(projectId: number, commit: AutoDeployCommit, source: AutoDeploySource): boolean {
  // The action row (actions table) is the deploy log: trigger and commit go in its meta.
  const meta = {
    projectId,
    triggeredBy: source,
    commitSha: commit.sha,
    commitMessage: commit.commitMessage,
    commitAuthor: commit.commitAuthor,
  };
  const started = actionRegistry.tryStart(projectRepoKey(projectId), "deploy", meta, async () => {
    const result = await deployProject(projectId, "auto", null, commit.sha);
    return { ok: result.ok, output: result.output };
  });
  return started !== null;
}

/** Deploys a new commit now, or queues it to run as soon as the project's current
 *  action ends. A queued commit is not recorded as last_commit_sha until it starts,
 *  so if Stackport restarts meanwhile the poller still sees it as new. */
export function requestAutoDeploy(projectId: number, commit: AutoDeployCommit, source: AutoDeploySource): AutoDeployOutcome {
  if (start(projectId, commit, source)) {
    pending.delete(projectId);
    recordCommit(projectId, commit);
    emitProject(projectId);
    return "started";
  }
  pending.set(projectId, { commit, source });
  getDatabase().prepare("UPDATE projects SET pending_deploy_sha = ? WHERE id = ?").run(commit.sha, projectId);
  emitProject(projectId);
  return "queued";
}

/** Drops a queued deploy, e.g. when the project is paused or switched to manual. */
export function clearPendingAutoDeploy(projectId: number): void {
  if (!pending.delete(projectId)) return;
  getDatabase().prepare("UPDATE projects SET pending_deploy_sha = NULL WHERE id = ?").run(projectId);
}

actionRegistry.onFinish((record) => {
  if (record.projectId === undefined || record.key !== projectRepoKey(record.projectId)) return;
  const projectId = record.projectId;
  const queued = pending.get(projectId);
  if (!queued) return;
  // Let the finishing action settle before starting the next one in the same slot.
  setImmediate(() => {
    if (pending.get(projectId) !== queued) return;
    const row = getDatabase().prepare("SELECT paused, deploy_trigger FROM projects WHERE id = ?").get(projectId) as { paused: number; deploy_trigger: string } | undefined;
    if (!row || row.paused || row.deploy_trigger === "manual") {
      clearPendingAutoDeploy(projectId);
      emitProject(projectId);
      return;
    }
    requestAutoDeploy(projectId, queued.commit, queued.source);
  });
});

/** A restart loses the in-memory queue; clear stale markers so the UI doesn't show a
 *  deploy that will never start. The commit still differs from last_commit_sha, so
 *  the poller picks it up on its next pass. */
export function resetPendingAutoDeploys(): void {
  getDatabase().prepare("UPDATE projects SET pending_deploy_sha = NULL WHERE pending_deploy_sha IS NOT NULL").run();
}
