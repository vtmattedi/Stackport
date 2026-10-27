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
  /** When a rollback moved away from this revision; such revisions are skipped by a
   *  default rollback but can still be picked explicitly. */
  rolledBackAt: string | null;
  /** Set when the revision's post-deploy health check didn't pass in time. It stays
   *  `active`: it is what is running. */
  healthFailedAt: string | null;
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
  rolled_back_at: string | null;
  health_failed_at: string | null;
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
    rolledBackAt: row.rolled_back_at,
    healthFailedAt: row.health_failed_at,
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
      SELECT id FROM project_deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?
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

/** `rollback` marks the revision being replaced as rolled back from. */
export function recordSuccessfulDeployment(projectId: number, input: RecordDeploymentInput, opts: { rollback?: boolean } = {}): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE project_deployments SET status = 'superseded'${opts.rollback ? ", rolled_back_at = ?" : ""} WHERE project_id = ? AND status = 'active'`
    ).run(...(opts.rollback ? [new Date().toISOString(), projectId] : [projectId]));
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

/** Marks the running revision as having failed its post-deploy health check. */
export function markActiveDeploymentUnhealthy(projectId: number): void {
  getDatabase()
    .prepare("UPDATE project_deployments SET health_failed_at = ? WHERE project_id = ? AND status = 'active'")
    .run(new Date().toISOString(), projectId);
}

/** Summaries only (no source/effective compose bodies, which can be sizeable text
 *  blobs) — for the revision-history list UI. */
export function listProjectDeployments(projectId: number, limit = RETENTION_LIMIT): ProjectDeploymentSummary[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?")
    .all(projectId, limit) as DeploymentRow[];
  return rows.map(rowToSummary);
}

export function getProjectDeployment(projectId: number, deploymentId: number): ProjectDeploymentDetail | null {
  const row = getDatabase()
    .prepare("SELECT * FROM project_deployments WHERE id = ? AND project_id = ?")
    .get(deploymentId, projectId) as DeploymentRow | undefined;
  return row ? rowToDetail(row) : null;
}

/** The revision that is running, if any deploy has recorded one. */
export function getActiveDeployment(projectId: number): ProjectDeploymentDetail | null {
  const row = getDatabase()
    .prepare("SELECT * FROM project_deployments WHERE project_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
    .get(projectId) as DeploymentRow | undefined;
  return row ? rowToDetail(row) : null;
}

function isRestorable(row: DeploymentRow): boolean {
  return (row.status === "active" || row.status === "superseded")
    && row.commit_sha !== null && row.compose_file_name !== null && row.effective_compose !== null;
}

function sameRevision(a: DeploymentRow, b: DeploymentRow): boolean {
  return a.commit_sha === b.commit_sha && a.compose_file_name === b.compose_file_name && a.effective_compose === b.effective_compose;
}

export type RollbackTarget = { ok: true; target: ProjectDeploymentDetail } | { ok: false; error: string };

/** What `rollbackProject` (projectDeploy.ts) restores. With `deploymentId`, that
 *  revision, if it can be restored and isn't what is already running. Without, the
 *  newest earlier revision that differs from the running one and that no rollback has
 *  moved away from, so rolling back twice keeps going back instead of returning to
 *  the revision the first rollback left. Ordered by id: created_at has one-second
 *  resolution. */
export function resolveRollbackTarget(projectId: number, deploymentId?: number): RollbackTarget {
  const db = getDatabase();
  const active = db
    .prepare("SELECT * FROM project_deployments WHERE project_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
    .get(projectId) as DeploymentRow | undefined;

  if (deploymentId !== undefined) {
    const row = db
      .prepare("SELECT * FROM project_deployments WHERE id = ? AND project_id = ?")
      .get(deploymentId, projectId) as DeploymentRow | undefined;
    if (!row) return { ok: false, error: "Deployment not found for this project." };
    if (!isRestorable(row)) return { ok: false, error: "That deployment can't be restored: it failed or has no recorded commit and compose file." };
    if (active && sameRevision(row, active)) return { ok: false, error: "That revision is already the one running." };
    return { ok: true, target: rowToDetail(row) };
  }

  const candidates = db
    .prepare("SELECT * FROM project_deployments WHERE project_id = ? AND status = 'superseded' AND rolled_back_at IS NULL ORDER BY id DESC")
    .all(projectId) as DeploymentRow[];
  const target = candidates.find((row) => isRestorable(row) && !(active && sameRevision(row, active)));
  return target
    ? { ok: true, target: rowToDetail(target) }
    : { ok: false, error: "No earlier successful deployment to roll back to." };
}
