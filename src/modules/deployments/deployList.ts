import { getDatabase } from "../../config/database";
import { DEPLOY_KINDS_SQL } from "../actions/registry";

interface DeployActionRow {
  id: string;
  project_id: number;
  kind: string;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  branch: string | null;
  triggered_by: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  log_path: string | null;
}

export interface DeployHistoryEntry {
  id: string;
  projectId: number;
  kind: string;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  triggeredBy: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  hasLog: boolean;
}

/** Recent deploy-type actions (manual, auto, webhook, rollback, ...) from the actions log, newest first; null when the project does not exist. */
export function listProjectDeploys(projectId: number): DeployHistoryEntry[] | null {
  const db = getDatabase();
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) return null;
  const rows = db.prepare(
    `SELECT * FROM actions WHERE project_id = ? AND kind IN (${DEPLOY_KINDS_SQL}) ORDER BY started_at DESC LIMIT 50`
  ).all(projectId) as DeployActionRow[];
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    commitAuthor: r.commit_author,
    branch: r.branch,
    triggeredBy: r.triggered_by,
    status: r.status,
    createdAt: r.started_at,
    completedAt: r.finished_at,
    hasLog: r.log_path !== null,
  }));
}
