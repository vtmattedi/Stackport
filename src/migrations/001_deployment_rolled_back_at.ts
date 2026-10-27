import type { Migration } from "./index";

/** Set on the revision a rollback moved away from, so the next default rollback keeps
 *  going back instead of returning to it (projectDeployments.ts). */
const migration: Migration = {
  id: 1,
  name: "deployment_rolled_back_at",
  up(db) {
    const cols = db.prepare("PRAGMA table_info(project_deployments)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "rolled_back_at")) {
      db.exec("ALTER TABLE project_deployments ADD COLUMN rolled_back_at TEXT");
    }
  },
};

export default migration;
