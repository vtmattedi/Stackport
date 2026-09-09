import { getDatabase } from "../config/database";

/** Phase 1.7 — one row per deploy attempt (stackport_yml.md §10-13). At most one
 *  `active` row per project at a time; a new successful deploy flips the previous
 *  `active` row to `superseded` and inserts the new one. Failed/rejected attempts
 *  insert a `failed` row without touching the active revision — a broken pull/build
 *  never destroys the last known-good deployment. */

const RETENTION_LIMIT = 20;

export type DeploymentStatus = "active" | "failed" | "superseded";

export interface ProjectDeploymentSummary {
  id: number;
  projectId: number;
  commitSha: string | null;
  branch: string | null;
  composeFileName: string | null;
  status: DeploymentStatus;
  triggeredBy: string;
  blockedReason: string | null;
  createdAt: string;
}

export interface ProjectDeploymentDetail extends ProjectDeploymentSummary {
  sourceCompose: string | null;
  effectiveCompose: string | null;
}

interface DeploymentRow {
  id: number;
  project_id: number;
  commit_sha: string | null;
  branch: string | null;
  compose_file_name: string | null;
  source_compose: string | null;
  effective_compose: string | null;
  status: DeploymentStatus;
  triggered_by: string;
  blocked_reason: string | null;
  created_at: string;
}

function rowToSummary(row: DeploymentRow): ProjectDeploymentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    branch: row.branch,
    composeFileName: row.compose_file_name,
    status: row.status,
    triggeredBy: row.triggered_by,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
  };
}

function rowToDetail(row: DeploymentRow): ProjectDeploymentDetail {
  return { ...rowToSummary(row), sourceCompose: row.source_compose, effectiveCompose: row.effective_compose };
}

function pruneOldDeployments(projectId: number): void {
  // Keeps the most recent RETENTION_LIMIT rows regardless of status — the active row
  // (always recent, since it's the last insert) and the previous successful
  // (superseded) row are naturally within that window in normal operation; this is a
  // simple recency cap, not a semantic "protect active/previous" rule, matching the
  // project_resource_samples retention pattern already used elsewhere.
  getDatabase().prepare(`
    DELETE FROM project_deployments
    WHERE project_id = ? AND id NOT IN (
      SELECT id FROM project_deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    )
  `).run(projectId, projectId, RETENTION_LIMIT);
}

export interface RecordDeploymentInput {
  commitSha: string | null;
  branch: string | null;
  composeFileName: string | null;
  sourceCompose: string | null;
  effectiveCompose: string | null;
  triggeredBy: string;
}

export function recordSuccessfulDeployment(projectId: number, input: RecordDeploymentInput): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare("UPDATE project_deployments SET status = 'superseded' WHERE project_id = ? AND status = 'active'").run(projectId);
    db.prepare(`
      INSERT INTO project_deployments (project_id, commit_sha, branch, compose_file_name, source_compose, effective_compose, status, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(projectId, input.commitSha, input.branch, input.composeFileName, input.sourceCompose, input.effectiveCompose, input.triggeredBy);
  });
  tx();
  pruneOldDeployments(projectId);
}

export function recordFailedDeployment(
  projectId: number,
  input: Pick<RecordDeploymentInput, "commitSha" | "branch" | "composeFileName" | "triggeredBy">,
  blockedReason: string
): void {
  getDatabase().prepare(`
    INSERT INTO project_deployments (project_id, commit_sha, branch, compose_file_name, status, triggered_by, blocked_reason)
    VALUES (?, ?, ?, ?, 'failed', ?, ?)
  `).run(projectId, input.commitSha, input.branch, input.composeFileName, input.triggeredBy, blockedReason);
  pruneOldDeployments(projectId);
}

/** Summaries only (no source/effective compose bodies, which can be sizeable text
 *  blobs) — for the revision-history list UI. */
export function listProjectDeployments(projectId: number, limit = RETENTION_LIMIT): ProjectDeploymentSummary[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(projectId, limit) as DeploymentRow[];
  return rows.map(rowToSummary);
}

export function getProjectDeployment(projectId: number, deploymentId: number): ProjectDeploymentDetail | null {
  const row = getDatabase()
    .prepare("SELECT * FROM project_deployments WHERE id = ? AND project_id = ?")
    .get(deploymentId, projectId) as DeploymentRow | undefined;
  return row ? rowToDetail(row) : null;
}

/** The revision immediately before the current active one — what `rollbackProject`
 *  (projectDeploy.ts) restores. Includes both 'active' and 'superseded' as "was
 *  successful" states since a fresh project's very first deployment has nothing
 *  before it yet (returns null). */
export function getPreviousSuccessfulDeployment(projectId: number): ProjectDeploymentDetail | null {
  const row = getDatabase()
    .prepare(`
      SELECT * FROM project_deployments
      WHERE project_id = ? AND status IN ('active', 'superseded')
      ORDER BY created_at DESC LIMIT 1 OFFSET 1
    `)
    .get(projectId) as DeploymentRow | undefined;
  return row ? rowToDetail(row) : null;
}
