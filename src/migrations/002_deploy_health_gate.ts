import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Health-gated deploys (projectDeploy.ts verifyDeployHealth): how long a deploy waits
 *  for the health check to pass, whether a failure rolls back automatically, and the
 *  failure itself on the revision. A new status value would need a table rebuild,
 *  which the additive-only rule forbids, so the failure is a column. */
const migration: Migration = {
  id: 2,
  name: "deploy_health_gate",
  up(db) {
    if (!hasColumn(db, "projects", "deploy_health_grace_s")) {
      db.exec("ALTER TABLE projects ADD COLUMN deploy_health_grace_s INTEGER NOT NULL DEFAULT 60");
    }
    if (!hasColumn(db, "projects", "auto_rollback_unhealthy")) {
      db.exec("ALTER TABLE projects ADD COLUMN auto_rollback_unhealthy INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasColumn(db, "project_deployments", "health_failed_at")) {
      db.exec("ALTER TABLE project_deployments ADD COLUMN health_failed_at TEXT");
    }
  },
};

export default migration;
