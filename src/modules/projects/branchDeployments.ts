import { createHash } from "crypto";
import { getDatabase } from "../../config/database";
import { attachDomains, type ProjectDomain } from "../ingress/domains";
import { addManagedProjectDomain, getDefaultManagedDomain, reserveLabel } from "../ingress/managedDomains";
import { isValidBranchName } from "./branchName";
import { rowToProject, type Project, type ProjectRow } from "./types";

export type BranchDeployment = Project & { domains: ProjectDomain[] };

export class BranchDeploymentError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function listBranchDeployments(parentId: number): BranchDeployment[] {
  const rows = getDatabase().prepare("SELECT * FROM projects WHERE branch_parent_id = ? ORDER BY auto_deploy_branch").all(parentId) as ProjectRow[];
  return attachDomains(rows.map(rowToProject));
}

export function hasBranchDeployments(parentId: number): boolean {
  return !!getDatabase().prepare("SELECT 1 FROM projects WHERE branch_parent_id = ? LIMIT 1").get(parentId);
}

export function createBranchDeployment(parentId: number, input: { branch?: unknown; env?: unknown; commentOnPullRequest?: unknown }): BranchDeployment {
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  if (!isValidBranchName(branch)) throw new BranchDeploymentError(400, "Choose a valid Git branch.");
  if (input.env !== "shared" && input.env !== "separate") throw new BranchDeploymentError(400, "Choose shared or separate env files.");
  const db = getDatabase();
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(parentId) as ProjectRow | undefined;
    if (!row) throw new BranchDeploymentError(404, "Project not found.");
    const parent = rowToProject(row);
    if (parent.branchParentId || parent.sourceType !== "github" || !parent.githubRepo) {
      throw new BranchDeploymentError(400, "Branch deployments belong to a GitHub project.");
    }
    const primary = db.prepare("SELECT branch FROM project_deployments WHERE project_id = ? AND status = 'active'").get(parentId) as { branch: string | null } | undefined;
    if (!primary?.branch && !parent.autoDeployBranch) throw new BranchDeploymentError(409, "Set the primary deployment's branch before adding another branch.");
    if (branch === primary?.branch || branch === parent.autoDeployBranch) throw new BranchDeploymentError(409, "This branch already belongs to the primary deployment.");
    if (db.prepare("SELECT 1 FROM projects WHERE branch_parent_id = ? AND auto_deploy_branch = ?").get(parentId, branch)) {
      throw new BranchDeploymentError(409, "This branch already has a deployment.");
    }
    if (input.commentOnPullRequest === true && parent.githubAuthMode !== "app") {
      throw new BranchDeploymentError(400, "Posting the URL to a pull request requires the GitHub App.");
    }
    const base = getDefaultManagedDomain();
    if (!base) throw new BranchDeploymentError(409, "Add a default base domain in Settings > Domains to generate branch URLs.");
    // A distinct runtime ID scopes the checkout, Compose stack, domain aliases and managed data.
    const branchName = branch.length > 90 ? `${branch.slice(0, 80)}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}` : branch;
    const name = `${parent.name.slice(0, 85)} (${branchName}, #${parentId})`;
    const now = new Date().toISOString();
    const id = Number(db.prepare(`
      INSERT INTO projects (name, group_name, github_repo, credential_id, github_credential_id, github_auth_mode,
        github_installation_id, github_repository_id, source_type, auto_deploy_branch, deploy_trigger,
        branch_parent_id, branch_share_env, branch_comment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'github', ?, 'manual', ?, ?, ?, ?, ?)
    `).run(name, parent.groupName, parent.githubRepo, parent.credentialId, parent.githubCredentialId, parent.githubAuthMode,
      parent.githubInstallationId, parent.githubRepositoryId, branch, parentId, input.env === "shared" ? 1 : 0, input.commentOnPullRequest === true ? 1 : 0, now, now).lastInsertRowid);
    const label = reserveLabel(base, `${parent.name.slice(0, 25)}-${branch}`);
    const domain = addManagedProjectDomain(id, base.id, label);
    const deployment = rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow);
    return { ...deployment, domains: [domain] };
  }).immediate();
}

/** Guard every checkout entry point, including API, webhooks and MCP. */
export function branchCheckoutConflict(project: Project, requestedBranch: string | null | undefined): string | null {
  if (project.branchParentId) {
    return requestedBranch && requestedBranch !== project.autoDeployBranch
      ? `This deployment is pinned to ${project.autoDeployBranch}. Add a separate deployment for ${requestedBranch}.` : null;
  }
  const branch = requestedBranch ?? project.autoDeployBranch;
  return branch && getDatabase().prepare("SELECT 1 FROM projects WHERE branch_parent_id = ? AND auto_deploy_branch = ?").get(project.id, branch)
    ? `${branch} already has its own deployment. Open it from Branch deployments.` : null;
}
