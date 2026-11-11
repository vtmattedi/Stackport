import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** What makes a project that deploys through the GitHub App deploy (modules M2 and M3): NULL or 'push' (a push to its branch,
 *  as before), 'ci' (a pushed commit once its checks pass) or 'release' (a published release). `github_pending_ci_*` holds the
 *  commit waiting for its checks. Additive only. */
const migration: Migration = {
  id: 20,
  name: "github_deploy_on",
  up(db) {
    for (const [column, type] of [["github_deploy_on", "TEXT"], ["github_pending_ci_sha", "TEXT"], ["github_pending_ci_at", "TEXT"]] as const) {
      if (!hasColumn(db, "projects", column)) db.exec(`ALTER TABLE projects ADD COLUMN ${column} ${type}`);
    }
  },
};

export default migration;
