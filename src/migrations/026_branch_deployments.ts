import type { Migration } from "./index";

const migration: Migration = {
  id: 26,
  name: "branch deployments",
  up(db) {
    const columns = new Set((db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((column) => column.name));
    if (!columns.has("branch_parent_id")) db.exec("ALTER TABLE projects ADD COLUMN branch_parent_id INTEGER REFERENCES projects(id)");
    if (!columns.has("branch_share_env")) db.exec("ALTER TABLE projects ADD COLUMN branch_share_env INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("branch_comment")) db.exec("ALTER TABLE projects ADD COLUMN branch_comment INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("branch_comment_key")) db.exec("ALTER TABLE projects ADD COLUMN branch_comment_key TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_branch_deployments
        ON projects (branch_parent_id, auto_deploy_branch) WHERE branch_parent_id IS NOT NULL;
    `);
  },
};

export default migration;
