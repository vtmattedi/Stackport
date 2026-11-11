import { logger } from "../../shared/logger";
import { listProjectDomains } from "../ingress/domains";
import { installationToken } from "./app";
import { defaultGithubClient, type GithubClient } from "./client";
import { getApp, getInstallation } from "./store";

/**
 * Module M1: each deploy of a project that goes through the GitHub App is reported to GitHub as a deployment, with a status
 * (in progress, then success or failure), so GitHub shows that a commit was deployed and where.
 *
 * It is a courtesy, never a dependency: it runs only for an installation that has approved `deployments: write`, and any
 * failure is logged and ignored. A deploy is never held up, slowed or failed by GitHub being slow or refusing.
 */

export interface DeployReport {
  repo: string;
  installationId: number;
  deploymentId: number;
  logUrl: string | null;
  environmentUrl: string | null;
}

export interface ReportableProject {
  id: number;
  name: string;
  githubRepo: string | null;
  githubAuthMode: "app" | null;
  githubInstallationId: number | null;
}

/** Whether this project's installation has approved the deployments permission. */
export function reportingAvailable(project: ReportableProject): boolean {
  if (project.githubAuthMode !== "app" || !project.githubRepo || project.githubInstallationId === null) return false;
  const installation = getInstallation(project.githubInstallationId);
  return installation?.status === "linked" && installation.permissions["deployments"] === "write";
}

function urls(project: ReportableProject): { logUrl: string | null; environmentUrl: string | null } {
  const origin = getApp()?.registeredOrigin ?? null;
  const host = listProjectDomains(project.id).find((d) => d.service && d.containerPort) ?? null;
  return {
    logUrl: origin ? `${origin}/projects/${project.id}` : null,
    environmentUrl: host ? `${host.useSsl ? "https" : "http"}://${host.domain}` : null,
  };
}

/** Creates the deployment and marks it in progress. Returns null when nothing is reported (not available, or GitHub said no). */
export async function beginDeployReport(project: ReportableProject, sha: string | null, client: GithubClient = defaultGithubClient()): Promise<DeployReport | null> {
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || !reportingAvailable(project)) return null;
  const repo = project.githubRepo as string;
  const installationId = project.githubInstallationId as number;
  try {
    const token = await installationToken(installationId, client);
    const { logUrl, environmentUrl } = urls(project);
    const { body } = await client.request<{ id?: number }>({
      method: "POST", path: `/repos/${repo}/deployments`, bearer: token,
      // required_contexts is empty: GitHub must not refuse the record because some check is still pending.
      body: { ref: sha, environment: "production", description: `Stackport deploy of ${project.name}`.slice(0, 140), auto_merge: false, required_contexts: [], production_environment: true, transient_environment: false },
    });
    if (typeof body?.id !== "number") return null;
    await client.request({ method: "POST", path: `/repos/${repo}/deployments/${body.id}/statuses`, bearer: token, body: { state: "in_progress", description: "Deploying", ...(logUrl ? { log_url: logUrl } : {}) } });
    return { repo, installationId, deploymentId: body.id, logUrl, environmentUrl };
  } catch (err) {
    logger.warn({ err, projectId: project.id }, "github-app: could not report the start of a deploy");
    return null;
  }
}

export async function finishDeployReport(report: DeployReport | null, outcome: { ok: boolean; healthy: boolean }, client: GithubClient = defaultGithubClient()): Promise<void> {
  if (!report) return;
  try {
    const token = await installationToken(report.installationId, client);
    const state = outcome.ok ? "success" : "failure";
    const description = outcome.ok ? "Deployed" : outcome.healthy ? "The deploy failed" : "Deployed, but it failed its health check";
    await client.request({
      method: "POST", path: `/repos/${report.repo}/deployments/${report.deploymentId}/statuses`, bearer: token,
      body: { state, description, ...(report.logUrl ? { log_url: report.logUrl } : {}), ...(outcome.ok && report.environmentUrl ? { environment_url: report.environmentUrl } : {}) },
    });
  } catch (err) {
    logger.warn({ err }, "github-app: could not report the end of a deploy");
  }
}
