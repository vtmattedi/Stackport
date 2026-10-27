import https from "https";
import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { rowToProject, type Project, type ProjectRow } from "../entities/Project";
import { requestAutoDeploy } from "./autoDeploy";
import { emitProjectDataUpdate } from "./realtime";

export interface GitHubPollerConfig {
  enabled: boolean;
  credentialId: number | null;
  pollIntervalS: number;
  lastPolledAt: string | null;
  lastError: string | null;
  lastPollOutput: string | null;
  /** Also check webhook projects every WEBHOOK_SAFETY_INTERVAL_MS, to catch pushes whose delivery was lost. */
  webhookSafetyCheck: boolean;
  updatedAt: string | null;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAt: string | null;
}

interface GithubPollerRow {
  id: number;
  enabled: number;
  credential_id: number | null;
  poll_interval_s: number;
  last_polled_at: string | null;
  last_error: string | null;
  last_poll_output: string | null;
  webhook_safety_check?: number;
  updated_at: string;
}

interface GitHubApiCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
}

interface GitHubApiBranch {
  name: string;
  commit: { sha: string; url: string };
}

interface GitHubResponse {
  status: number;
  body: unknown;
  etag: string | null;
  rateRemaining: number | null;
}

/** Conditional-request cache: GitHub doesn't count 304 Not Modified replies against
 *  the rate limit, so re-polling unchanged branch lists is effectively free. */
const etagCache = new Map<string, { etag: string; body: unknown }>();
const MAX_BRANCH_PAGES = 10;

/** Rate-limit headroom from the most recent GitHub response, surfaced in poll output. */
let lastRateRemaining: number | null = null;

function httpGet(url: string, token: string | null): Promise<GitHubResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "stackport-github-poller/1.0",
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const cacheKey = `${token ? "auth" : "anon"}:${url}`;
    const cached = etagCache.get(cacheKey);
    if (cached) headers["If-None-Match"] = cached.etag;

    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const remainingHeader = res.headers["x-ratelimit-remaining"];
          const rateRemaining = typeof remainingHeader === "string" ? Number(remainingHeader) : null;
          if (rateRemaining !== null && Number.isFinite(rateRemaining)) lastRateRemaining = rateRemaining;
          const etagHeader = res.headers["etag"];
          const etag = typeof etagHeader === "string" ? etagHeader : null;

          if (res.statusCode === 304 && cached) {
            resolve({ status: 304, body: cached.body, etag: cached.etag, rateRemaining });
            return;
          }
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            const resetHeader = res.headers["x-ratelimit-reset"];
            const rateLimited = (res.statusCode === 403 || res.statusCode === 429) && rateRemaining === 0;
            const hint = rateLimited
              ? ` (rate limit exhausted${typeof resetHeader === "string" ? `, resets at ${new Date(Number(resetHeader) * 1000).toISOString()}` : ""}${token ? "" : " — configure a GitHub token to raise the limit from 60/h to 5000/h"})`
              : res.statusCode === 404 && !token
                ? " (repo not found — private repos need a GitHub token)"
                : "";
            reject(new Error(`GitHub API ${res.statusCode}${hint}: ${body.slice(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(body) as unknown;
          if (etag) etagCache.set(cacheKey, { etag, body: parsed });
          resolve({ status: res.statusCode ?? 200, body: parsed, etag, rateRemaining });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error("GitHub API request timed out"));
    });
  });
}

function resolveToken(credentialId: number | null): string | null {
  const db = getDatabase();
  const query = credentialId != null
    ? "SELECT secret_enc FROM credentials WHERE id = ? AND type = 'github'"
    : "SELECT secret_enc FROM credentials WHERE type = 'github' AND is_default = 1 LIMIT 1";
  const row = db.prepare(query).get(...(credentialId != null ? [credentialId] : [])) as { secret_enc: string } | undefined;
  if (!row) return null;
  try {
    return decryptSecret(row.secret_enc);
  } catch {
    return null;
  }
}

function projectToken(project: Project, globalCredentialId: number | null): string | null {
  const credId = project.githubCredentialId ?? project.credentialId;
  if (credId != null) return resolveToken(credId);
  return resolveToken(globalCredentialId);
}

/** The token used for GitHub API calls on this project's repo (project credential, else the poller's). */
export function tokenForProject(project: Project): string | null {
  return projectToken(project, globalCredentialId());
}

function globalCredentialId(): number | null {
  const row = getDatabase().prepare("SELECT credential_id FROM github_poller_config WHERE id = 1").get() as { credential_id: number | null } | undefined;
  return row?.credential_id ?? null;
}

async function fetchBranchesRaw(repo: string, token: string | null): Promise<GitHubApiBranch[]> {
  const all: GitHubApiBranch[] = [];
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    const { body } = await httpGet(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`, token);
    const batch = Array.isArray(body) ? (body as GitHubApiBranch[]) : [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function fetchCommit(repo: string, sha: string, token: string | null): Promise<GitHubApiCommit> {
  const { body } = await httpGet(`https://api.github.com/repos/${repo}/commits/${sha}`, token);
  return body as GitHubApiCommit;
}

/**
 * Lists a repo's branches with head-commit details. Commit details are reused from
 * `cached` whenever a branch's head SHA hasn't moved, so a steady-state poll costs one
 * (usually 304, i.e. free) request per project instead of one request per branch —
 * the old per-branch fetch burned through the 60/h anonymous rate limit within minutes.
 */
async function fetchBranchList(repo: string, token: string | null, cached: GitHubBranch[]): Promise<GitHubBranch[]> {
  const raw = await fetchBranchesRaw(repo, token);
  const cachedBySha = new Map(cached.filter((b) => b.commitAt !== null).map((b) => [b.sha, b]));
  const branches: GitHubBranch[] = [];
  for (const b of raw) {
    const known = cachedBySha.get(b.commit.sha);
    if (known) {
      branches.push({ ...known, name: b.name });
      continue;
    }
    try {
      const commitData = await fetchCommit(repo, b.commit.sha, token);
      branches.push({
        name: b.name,
        sha: b.commit.sha,
        commitMessage: commitData.commit.message.split("\n")[0] ?? null,
        commitAuthor: commitData.commit.author.name ?? null,
        commitAt: commitData.commit.author.date ?? null,
      });
    } catch {
      branches.push({ name: b.name, sha: b.commit.sha, commitMessage: null, commitAuthor: null, commitAt: null });
    }
  }
  return branches;
}

function storeBranchList(projectId: number, branches: GitHubBranch[]): void {
  const db = getDatabase();
  db.prepare("UPDATE projects SET branches_json = ?, branches_fetched_at = ? WHERE id = ?")
    .run(JSON.stringify(branches), new Date().toISOString(), projectId);
}

function markChecked(projectId: number, error: string | null): void {
  getDatabase().prepare("UPDATE projects SET github_checked_at = ?, github_check_error = ? WHERE id = ?")
    .run(new Date().toISOString(), error ? error.slice(0, 500) : null, projectId);
}

function emitProjectRow(projectId: number): void {
  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (row) emitProjectDataUpdate(projectId, rowToProject(row));
}

/** Fetches the branch list from GitHub, stores it on the project, and pushes it to subscribed clients. */
export async function refreshProjectBranches(project: Project): Promise<GitHubBranch[]> {
  if (!project.githubRepo) return [];
  const token = projectToken(project, globalCredentialId());
  const branches = await fetchBranchList(project.githubRepo, token, project.branches);
  storeBranchList(project.id, branches);
  emitProjectRow(project.id);
  return branches;
}

/** Cached branch list when one exists (kept fresh by the poller), otherwise a live fetch. */
export async function getProjectBranches(project: Project, opts: { refresh?: boolean } = {}): Promise<GitHubBranch[]> {
  if (!project.githubRepo) return [];
  if (!opts.refresh && project.branches.length > 0) return project.branches;
  return refreshProjectBranches(project);
}

/**
 * Called after a project update. A different repo invalidates the cached branch list,
 * and a different repo or auto-deploy branch invalidates the commit baseline — without
 * this, switching branches made the next poll treat the other branch's head as a "new
 * commit" and auto-deploy it immediately.
 */
export function resetGithubTrackingIfChanged(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  before: { github_repo: string | null; auto_deploy_branch: string | null },
  githubRepo: string | null,
  autoDeployBranch: string | null,
): void {
  const repoChanged = (before.github_repo ?? null) !== (githubRepo ?? null);
  const branchChanged = (before.auto_deploy_branch ?? null) !== (autoDeployBranch ?? null);
  if (repoChanged) {
    db.prepare("UPDATE projects SET branches_json = NULL, branches_fetched_at = NULL WHERE id = ?").run(projectId);
  }
  if (repoChanged || branchChanged) {
    db.prepare(
      "UPDATE projects SET last_commit_sha = NULL, last_commit_message = NULL, last_commit_author = NULL, last_commit_at = NULL WHERE id = ?"
    ).run(projectId);
  }
}

const FIRST_POLL_DELAY_MS = 15_000;
const WEBHOOK_SAFETY_INTERVAL_MS = 30 * 60_000;

class GitHubPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  getConfig(): GitHubPollerConfig {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM github_poller_config WHERE id = 1").get() as GithubPollerRow | undefined;
    if (!row) return { enabled: false, credentialId: null, pollIntervalS: 300, lastPolledAt: null, lastError: null, lastPollOutput: null, webhookSafetyCheck: true, updatedAt: null };
    return {
      enabled: !!row.enabled,
      credentialId: row.credential_id,
      pollIntervalS: row.poll_interval_s,
      lastPolledAt: row.last_polled_at,
      lastError: row.last_error,
      lastPollOutput: row.last_poll_output,
      webhookSafetyCheck: row.webhook_safety_check !== 0,
      updatedAt: row.updated_at,
    };
  }

  saveConfig(data: { enabled?: boolean; credentialId?: number | null; pollIntervalS?: number; webhookSafetyCheck?: boolean }): GitHubPollerConfig {
    const db = getDatabase();
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM github_poller_config WHERE id = 1").get() as GithubPollerRow | undefined;

    if (!existing) {
      db.prepare(
        "INSERT INTO github_poller_config (id, enabled, credential_id, poll_interval_s, updated_at) VALUES (1, ?, ?, ?, ?)"
      ).run(data.enabled ? 1 : 0, data.credentialId ?? null, data.pollIntervalS ?? 300, now);
    } else {
      db.prepare(
        "UPDATE github_poller_config SET enabled = ?, credential_id = ?, poll_interval_s = ?, updated_at = ? WHERE id = 1"
      ).run(
        data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled,
        "credentialId" in data ? (data.credentialId ?? null) : existing.credential_id,
        data.pollIntervalS ?? existing.poll_interval_s,
        now,
      );
    }
    if (data.webhookSafetyCheck !== undefined) {
      db.prepare("UPDATE github_poller_config SET webhook_safety_check = ? WHERE id = 1").run(data.webhookSafetyCheck ? 1 : 0);
    }

    this.reschedule();
    return this.getConfig();
  }

  start(): void {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;
    // Poll soon after boot rather than a full interval later — otherwise a restart
    // (e.g. a self-update) silently delays auto-deploy by up to pollIntervalS.
    this.schedule(Math.min(FIRST_POLL_DELAY_MS, cfg.pollIntervalS * 1000));
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private reschedule(): void {
    this.stop();
    const cfg = this.getConfig();
    if (cfg.enabled) this.schedule(cfg.pollIntervalS * 1000);
  }

  private schedule(ms: number): void {
    // Always replace any pending timer: a manual "Poll now" or a config save while a
    // poll is in flight used to leave the old timer alive, stacking extra poll loops.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, ms);
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const db = getDatabase();
    const now = new Date().toISOString();
    const cfg = this.getConfig();
    const outputLines: string[] = [`Poll started at ${now}`];
    let errorCount = 0;

    try {
      // Webhook projects get a slow safety check on top of their hook: a push sent while
      // Stackport was down is never redelivered, and this catches it late instead of never.
      const safetyCutoff = new Date(Date.now() - WEBHOOK_SAFETY_INTERVAL_MS).toISOString();
      const projects = db.prepare(
        `SELECT * FROM projects WHERE github_repo IS NOT NULL AND github_repo != '' AND paused = 0
         AND (deploy_trigger = 'poller'
              OR (? = 1 AND deploy_trigger = 'webhook' AND (github_checked_at IS NULL OR github_checked_at < ?)))`
      ).all(cfg.webhookSafetyCheck ? 1 : 0, safetyCutoff) as ProjectRow[];

      outputLines.push(`Found ${projects.length} project(s) with GitHub repos`);

      for (const row of projects) {
        const project = rowToProject(row);
        if (!project.githubRepo) continue;
        const prefix = `  [${project.name}]`;
        try {
          const token = projectToken(project, cfg.credentialId);
          const branchList = await fetchBranchList(project.githubRepo, token, project.branches);
          storeBranchList(project.id, branchList);
          outputLines.push(`${prefix} ${branchList.length} branch(es) found`);

          const watchBranch = project.autoDeployBranch;
          const watched = watchBranch ? branchList.find((b) => b.name === watchBranch) : null;

          if (watchBranch && watched) {
            const shortSha = watched.sha.slice(0, 7);
            if (project.lastCommitSha === null) {
              db.prepare(
                "UPDATE projects SET last_commit_sha = ?, last_commit_message = ?, last_commit_author = ?, last_commit_at = ? WHERE id = ?"
              ).run(watched.sha, watched.commitMessage, watched.commitAuthor, watched.commitAt, project.id);
              outputLines.push(`${prefix} First poll on ${watchBranch}: ${shortSha} stored as baseline (no deploy)`);
            } else if (watched.sha !== project.lastCommitSha) {
              if (project.deployTrigger === "webhook" && project.pendingDeploySha !== watched.sha) {
                // The hook should have delivered this push already; flag it so the page shows the hook needs a look.
                db.prepare("UPDATE projects SET hook_status = 'failing' WHERE id = ?").run(project.id);
                outputLines.push(`${prefix} webhook missed ${shortSha}; deploying from the safety check`);
              }
              const outcome = requestAutoDeploy(project.id, watched, "auto");
              outputLines.push(outcome === "started"
                ? `${prefix} NEW commit on ${watchBranch}: ${shortSha} — ${watched.commitMessage ?? "—"} → deploy triggered`
                : `${prefix} NEW commit on ${watchBranch}: ${shortSha} — another action is running, deploy queued`);
            } else {
              outputLines.push(`${prefix} No new commits on ${watchBranch} (${shortSha})`);
            }
          } else if (watchBranch) {
            outputLines.push(`${prefix} Branch "${watchBranch}" not found in repo`);
          } else {
            outputLines.push(`${prefix} No auto-deploy branch set`);
          }

          markChecked(project.id, watchBranch && !watched ? `Branch "${watchBranch}" not found in repo` : null);
          emitProjectRow(project.id);
        } catch (err) {
          errorCount++;
          const msg = err instanceof Error ? err.message : String(err);
          outputLines.push(`${prefix} ERROR: ${msg}`);
          markChecked(project.id, msg);
          emitProjectRow(project.id);
        }
      }

      if (lastRateRemaining !== null) outputLines.push(`GitHub API rate limit remaining: ${lastRateRemaining}`);
      const output = outputLines.join("\n");
      db.prepare(
        "UPDATE github_poller_config SET last_polled_at = ?, last_error = ?, last_poll_output = ? WHERE id = 1"
      ).run(now, errorCount > 0 ? `${errorCount} project(s) failed to poll — see output` : null, output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputLines.push(`FATAL: ${msg}`);
      db.prepare(
        "UPDATE github_poller_config SET last_polled_at = ?, last_error = ?, last_poll_output = ? WHERE id = 1"
      ).run(now, msg, outputLines.join("\n"));
    } finally {
      this.running = false;
      const updatedCfg = this.getConfig();
      if (updatedCfg.enabled) this.schedule(updatedCfg.pollIntervalS * 1000);
    }
  }
}

export const githubPoller = new GitHubPoller();
