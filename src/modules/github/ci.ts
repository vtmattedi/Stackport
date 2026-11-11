import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { requestAutoDeploy } from "../automation/autoDeploy";
import { getProjectById, recordBlockedDeployAttempt } from "../deployments/operations";
import { installationToken } from "./app";
import { defaultGithubClient, GithubClient } from "./client";
import { getApp, getInstallation, listRepositories } from "./store";

/**
 * Modules M2 and M3: a project that deploys through the GitHub App can deploy only after the pushed commit's checks pass
 * (`ci`), or only when a release is published (`release`). Both are a per-project choice, `projects.github_deploy_on`.
 *
 * Waiting for checks, in plain rules:
 *  - while any check run or commit status is still running, the commit is held;
 *  - when they all pass, it deploys;
 *  - when one fails, it does not deploy, and the admin is told (the same "deploy blocked" notification as other blocks);
 *  - a repository with no checks at all would be held forever, so after a short grace period a commit with none deploys.
 *  A newer push replaces the held commit: five pushes while checks run lead to one deploy, not five.
 */

/** How long a commit with no checks at all is held, for GitHub to create them, before it is taken to have none. */
export const NO_CHECKS_GRACE_MS = 5 * 60_000;
/** A commit whose checks never finish is dropped after this long, with a note. */
export const MAX_HOLD_MS = 6 * 60 * 60_000;

export type CiState = "pending" | "success" | "failed" | "none";

interface CheckRun { status: string; conclusion: string | null }
const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/** What a commit's checks say right now, from GitHub. `none` means there are no check runs and no statuses. */
export async function evaluateCi(installationId: number, repo: string, sha: string, client: GithubClient = defaultGithubClient()): Promise<CiState> {
  const token = await installationToken(installationId, client);
  const { body: checks } = await client.request<{ total_count?: number; check_runs?: CheckRun[] }>({ path: `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, bearer: token });
  const { body: status } = await client.request<{ state?: string; total_count?: number }>({ path: `/repos/${repo}/commits/${sha}/status`, bearer: token });
  const runs = checks.check_runs ?? [];
  const statuses = status.total_count ?? 0;
  if (runs.length === 0 && statuses === 0) return "none";
  if (runs.some((r) => r.status === "completed" && r.conclusion !== null && FAILING.has(r.conclusion)) || (statuses > 0 && (status.state === "failure" || status.state === "error"))) return "failed";
  if (runs.some((r) => r.status !== "completed") || (statuses > 0 && status.state === "pending")) return "pending";
  return "success";
}

interface Held { id: number; name: string; github_repo: string | null; github_installation_id: number | null; github_pending_ci_sha: string; github_pending_ci_at: string; paused: number; deploy_trigger: string; auto_deploy_branch: string | null; last_commit_sha: string | null }

const HELD_SELECT = `SELECT id, name, github_repo, github_installation_id, github_pending_ci_sha, github_pending_ci_at, paused, deploy_trigger, auto_deploy_branch, last_commit_sha
  FROM projects WHERE github_auth_mode = 'app' AND github_deploy_on = 'ci' AND github_pending_ci_sha IS NOT NULL`;

export function holdForCi(projectId: number, sha: string, now: Date = new Date()): void {
  getDatabase().prepare("UPDATE projects SET github_pending_ci_sha = ?, github_pending_ci_at = ? WHERE id = ?").run(sha, now.toISOString(), projectId);
}

function release(projectId: number): void {
  getDatabase().prepare("UPDATE projects SET github_pending_ci_sha = NULL, github_pending_ci_at = NULL WHERE id = ?").run(projectId);
}

export type SettleResult = "deployed" | "held" | "failed" | "dropped" | "nothing";

/** Looks at one project's held commit and does what the rules say. Never throws. */
export async function settleProject(held: Held, now: Date = new Date(), client: GithubClient = defaultGithubClient()): Promise<SettleResult> {
  const sha = held.github_pending_ci_sha;
  const waited = now.getTime() - Date.parse(held.github_pending_ci_at.includes("T") ? held.github_pending_ci_at : `${held.github_pending_ci_at.replace(" ", "T")}Z`);
  if (!held.github_repo || held.github_installation_id === null) return "nothing";
  if (waited > MAX_HOLD_MS) {
    release(held.id);
    auditLog("github", "github-app.ci", held.name, "fail", { sha: sha.slice(0, 7), reason: "checks never finished" });
    return "dropped";
  }
  let state: CiState;
  try { state = await evaluateCi(held.github_installation_id, held.github_repo, sha, client); }
  catch (err) {
    logger.warn({ err, projectId: held.id }, "github-app: could not read a commit's checks; it stays held");
    return "held";
  }
  if (state === "pending" || (state === "none" && waited < NO_CHECKS_GRACE_MS)) return "held";
  if (state === "failed") {
    release(held.id);
    const project = getProjectById(held.id);
    if (project) recordBlockedDeployAttempt(project, { commitSha: sha, branch: held.auto_deploy_branch, composeFileName: null, triggeredBy: "auto" }, `The checks for ${sha.slice(0, 7)} failed, so it was not deployed.`, true);
    auditLog("github", "github-app.ci", held.name, "fail", { sha: sha.slice(0, 7), reason: "checks failed" });
    return "failed";
  }
  // success, or no checks at all after the grace period
  release(held.id);
  if (held.paused || held.deploy_trigger === "manual" || sha === held.last_commit_sha) return "nothing";
  requestAutoDeploy(held.id, { sha, commitMessage: null, commitAuthor: null, commitAt: null }, "webhook");
  auditLog("github", "github-app.ci", held.name, "ok", { sha: sha.slice(0, 7), checks: state });
  return "deployed";
}

/** Every held commit of a repository (after a push, or a check suite finishing). */
export async function settleRepository(installationId: number, repositoryId: number, sha: string | null, now: Date = new Date(), client: GithubClient = defaultGithubClient()): Promise<SettleResult[]> {
  const rows = getDatabase().prepare(`${HELD_SELECT} AND github_installation_id = ? AND github_repository_id = ?`).all(installationId, repositoryId) as Held[];
  const results: SettleResult[] = [];
  for (const held of rows) if (sha === null || held.github_pending_ci_sha === sha) results.push(await settleProject(held, now, client));
  return results;
}

/** All held commits: run on a timer, since a repository without checks never sends an event to wake them. */
export async function sweepHeldCommits(now: Date = new Date(), client: GithubClient = defaultGithubClient()): Promise<SettleResult[]> {
  const rows = getDatabase().prepare(HELD_SELECT).all() as Held[];
  const results: SettleResult[] = [];
  for (const held of rows) results.push(await settleProject(held, now, client));
  return results;
}

// ---- releases (M3)

/** Deploys a published release to every project bound to the repository that deploys on release. The tag is resolved to its
 *  commit through GitHub, and that exact commit is what is deployed. Prereleases and drafts are not deployed. */
export async function deployRelease(installationId: number, repositoryId: number, tag: string, prerelease: boolean, draft: boolean, client: GithubClient = defaultGithubClient()): Promise<string> {
  if (draft || prerelease) return `A ${draft ? "draft" : "prerelease"} is not deployed.`;
  if (!/^[A-Za-z0-9._\-/+]{1,200}$/.test(tag) || tag.includes("..")) return "The release's tag is not a name Stackport will deploy.";
  const installation = getInstallation(installationId);
  const repository = listRepositories(installationId).find((r) => r.repositoryId === repositoryId);
  if (!installation || installation.status !== "linked" || !repository) return "The App does not have access to this repository.";
  const targets = getDatabase().prepare(
    "SELECT id, name, paused, deploy_trigger, last_commit_sha FROM projects WHERE github_auth_mode = 'app' AND github_deploy_on = 'release' AND github_installation_id = ? AND github_repository_id = ?",
  ).all(installationId, repositoryId) as { id: number; name: string; paused: number; deploy_trigger: string; last_commit_sha: string | null }[];
  if (targets.length === 0) return `No project deploys ${repository.fullName} on release.`;

  let sha: string;
  try {
    const token = await installationToken(installationId, client);
    const { body } = await client.request<{ sha?: string }>({ path: `/repos/${repository.fullName}/commits/${encodeURIComponent(tag)}`, bearer: token });
    if (!body.sha || !/^[0-9a-f]{40,64}$/i.test(body.sha)) return `GitHub did not give a commit for ${tag}.`;
    sha = body.sha;
  } catch (err) {
    return `Could not resolve ${tag} to a commit: ${err instanceof Error ? err.message : "GitHub error"}.`;
  }
  const outcomes: string[] = [];
  for (const project of targets) {
    if (project.paused) { outcomes.push(`${project.name}: paused`); continue; }
    if (project.deploy_trigger === "manual") { outcomes.push(`${project.name}: deploys are manual`); continue; }
    if (sha === project.last_commit_sha) { outcomes.push(`${project.name}: ${tag} is already deployed`); continue; }
    const outcome = requestAutoDeploy(project.id, { sha, commitMessage: `Release ${tag}`, commitAuthor: null, commitAt: null }, "webhook");
    auditLog("github", "github-app.release", project.name, "ok", { tag, sha: sha.slice(0, 7), outcome });
    outcomes.push(`${project.name}: release ${tag} ${outcome === "started" ? "deploy started" : "deploy queued"}`);
  }
  return outcomes.join("; ");
}

/** The modules this instance's App was registered with: a project can only choose a mode its App can serve. */
export function modeAvailable(mode: "push" | "ci" | "release", installationId: number | null): string | null {
  if (mode === "push") return null;
  const app = getApp();
  const wanted = mode === "ci" ? "ci" : "releases";
  if (!app?.modules.includes(wanted)) return mode === "ci" ? "This App was registered without the CI module, so it cannot wait for checks." : "This App was registered without the releases module, so it cannot deploy releases.";
  if (mode === "ci") {
    const permissions = installationId === null ? null : getInstallation(installationId)?.permissions;
    if (!permissions || permissions["checks"] === undefined || permissions["statuses"] === undefined) return "This installation has not approved the permissions to read checks and statuses. Approve them on GitHub.";
  }
  return null;
}
