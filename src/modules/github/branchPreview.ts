import { getDatabase } from "../../config/database";
import { getProjectHealthCheckDomain } from "../ingress/domains";
import { checkProjectIngress } from "../ingress/health";
import { hasUsableCertificate } from "../ingress/nginx/configWriter";
import { rowToProject, type ProjectRow } from "../projects/types";
import { appTokenForProject } from "./binding";
import { defaultGithubClient, GithubError, type GithubClient } from "./client";

interface PullRequest { number: number; head: { ref: string; repo: { full_name: string } | null } }
const posting = new Set<number>();
const previewDeps = {
  certificate: hasUsableCertificate,
  token: appTokenForProject,
  client: defaultGithubClient,
  reachable: async (id: number, hostname: string) => (await checkProjectIngress(id)).routes.some((route) => route.domain === hostname && route.reachable),
};

/** Post only after an opted-in deployment is running and its generated HTTPS URL is usable. */
export async function announceBranchPreview(projectId: number, deps: {
  certificate: typeof hasUsableCertificate;
  token: typeof appTokenForProject;
  client: () => GithubClient;
  reachable: (id: number, hostname: string) => Promise<boolean>;
} = previewDeps): Promise<string> {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ? AND branch_parent_id IS NOT NULL AND branch_comment = 1 AND paused = 0").get(projectId) as (ProjectRow & { branch_comment_key: string | null }) | undefined;
  if (!row || posting.has(projectId)) return "";
  const project = rowToProject(row);
  if (!project.githubRepo || !project.autoDeployBranch || project.githubAuthMode !== "app") return "";
  const active = db.prepare("SELECT 1 FROM project_deployments WHERE project_id = ? AND status = 'active' AND branch = ? AND health_failed_at IS NULL").get(projectId, project.autoDeployBranch);
  if (!active) return "";
  const domain = getProjectHealthCheckDomain(projectId, project.healthCheckDomainId);
  if (!domain?.service || !domain.containerPort || !domain.useSsl) return "";
  posting.add(projectId);
  try {
    if (!await deps.certificate(domain.domain) || !await deps.reachable(projectId, domain.domain)) return "";
    const url = `https://${domain.domain}`;
    const client = deps.client();
    const bearer = await deps.token(projectId, client);
    const owner = project.githubRepo.split("/")[0];
    const repoPath = `/repos/${project.githubRepo}`;
    const head = encodeURIComponent(`${owner}:${project.autoDeployBranch}`);
    const { body } = await client.request<PullRequest[]>({ path: `${repoPath}/pulls?state=open&head=${head}&per_page=100`, bearer });
    const target = body.find((pr) => pr.head.ref === project.autoDeployBranch && pr.head.repo?.full_name.toLowerCase() === project.githubRepo?.toLowerCase());
    if (!target) return "The preview is ready. No open pull request matches this branch.";
    const key = `${target.number} ${url}`;
    if (row.branch_comment_key === key) return "";
    const current = getProjectHealthCheckDomain(projectId, project.healthCheckDomainId);
    if (current?.domain !== domain.domain || !current.useSsl) return "";
    await client.request({ method: "POST", path: `${repoPath}/issues/${target.number}/comments`, bearer, body: { body: `Stackport preview is ready: ${url}` } });
    db.prepare("UPDATE projects SET branch_comment_key = ? WHERE id = ?").run(key, projectId);
    return `Posted ${url} on pull request #${target.number}.`;
  } catch (err) {
    if (err instanceof GithubError && (err.status === 403 || err.status === 404)) {
      return "Could not post the preview URL. Check that the GitHub App has Pull requests: Read and write access to this repository.";
    }
    return "Could not post the preview URL. Try redeploying after GitHub is reachable.";
  } finally { posting.delete(projectId); }
}
