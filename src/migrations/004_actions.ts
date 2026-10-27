import type { Migration } from "./index";

/** Every action the runner tracks (services/actionRegistry.ts): one row per run, with
 *  the commit for deploy-type actions. Replaces project_deploys as the deploy log
 *  (Insights, "Recent deploys"); its rows are copied in once. project_deploys stays,
 *  unwritten, because `stackport rollback` may put back code that reads it. Output
 *  lives in a log file per action (log_path), not in the database. */
const migration: Migration = {
  id: 4,
  name: "actions",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        triggered_by TEXT NOT NULL DEFAULT 'manual',
        commit_sha TEXT,
        commit_message TEXT,
        commit_author TEXT,
        branch TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        log_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_actions_project_started ON actions (project_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_actions_key_started ON actions (key, started_at);
      CREATE INDEX IF NOT EXISTS idx_actions_status ON actions (status);

      INSERT OR IGNORE INTO actions
        (id, key, kind, project_id, status, triggered_by, commit_sha, commit_message, commit_author, started_at, finished_at)
      SELECT
        'legacy-' || id,
        'project:' || project_id || ':repo',
        'deploy',
        project_id,
        CASE status WHEN 'running' THEN 'interrupted' ELSE status END,
        triggered_by,
        commit_sha,
        commit_message,
        commit_author,
        created_at,
        completed_at
      FROM project_deploys;
    `);
  },
};

export default migration;
