import https from "https";
import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";
import { rowToProject, type Project, type ProjectRow } from "../entities/Project";
import { deployProject } from "./projectDeploy";
import { emitProjectDataUpdate } from "./realtime";

export interface GitHubPollerConfig {
  enabled: boolean;
  credentialId: number | null;
  pollIntervalS: number;
  lastPolledAt: string | null;
  lastError: string | null;
  lastPollOutput: string | null;
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

function httpGet(url: string, token: string | null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "stackport-mw-vps-manager-github-poller/1.0",
      "Accept": "application/vnd.github+json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          resolve(JSON.parse(body));
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

async function fetchBranchesRaw(repo: string, token: string | null): Promise<GitHubApiBranch[]> {
  const apiUrl = `https://api.github.com/repos/${repo}/branches?per_page=100`;
  return httpGet(apiUrl, token) as Promise<GitHubApiBranch[]>;
}

async function fetchCommit(repo: string, sha: string, token: string | null): Promise<GitHubApiCommit> {
  const commitUrl = `https://api.github.com/repos/${repo}/commits/${sha}`;
  return httpGet(commitUrl, token) as Promise<GitHubApiCommit>;
}

export async function getProjectBranches(project: Project): Promise<GitHubBranch[]> {
  if (!project.githubRepo) return [];
  const db = getDatabase();
  const cfgRow = db.prepare("SELECT credential_id FROM github_poller_config WHERE id = 1").get() as { credential_id: number | null } | undefined;
  const token = projectToken(project, cfgRow?.credential_id ?? null);
  const raw = await fetchBranchesRaw(project.githubRepo, token);

  const branches: GitHubBranch[] = [];
  for (const b of raw) {
    try {
      const commitData = await fetchCommit(project.githubRepo, b.commit.sha, token);
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

class GitHubPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  getConfig(): GitHubPollerConfig {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM github_poller_config WHERE id = 1").get() as GithubPollerRow | undefined;
    if (!row) return { enabled: false, credentialId: null, pollIntervalS: 300, lastPolledAt: null, lastError: null, lastPollOutput: null, updatedAt: null };
    return {
      enabled: !!row.enabled,
      credentialId: row.credential_id,
      pollIntervalS: row.poll_interval_s,
      lastPolledAt: row.last_polled_at,
      lastError: row.last_error,
      lastPollOutput: row.last_poll_output,
      updatedAt: row.updated_at,
    };
  }

  saveConfig(data: { enabled?: boolean; credentialId?: number | null; pollIntervalS?: number }): GitHubPollerConfig {
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

    this.reschedule();
    return this.getConfig();
  }

  start(): void {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;
    this.schedule(cfg.pollIntervalS * 1000);
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
    this.timer = setTimeout(() => { void this.poll(); }, ms);
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const db = getDatabase();
    const now = new Date().toISOString();
    const cfg = this.getConfig();
    const outputLines: string[] = [`Poll started at ${now}`];

    try {
      const projects = db.prepare(
        "SELECT * FROM projects WHERE github_repo IS NOT NULL AND paused = 0"
      ).all() as ProjectRow[];

      outputLines.push(`Found ${projects.length} project(s) with GitHub repos`);

      for (const row of projects) {
        const project = rowToProject(row);
        if (!project.githubRepo) continue;
        const prefix = `  [${project.name}]`;
        try {
          const token = projectToken(project, cfg.credentialId);
          const rawBranches = await fetchBranchesRaw(project.githubRepo, token);
          outputLines.push(`${prefix} ${rawBranches.length} branch(es) found`);

          // Fetch commit details for all branches (for branch list display)
          const branchList: GitHubBranch[] = [];
          for (const b of rawBranches) {
            try {
              const commitData = await fetchCommit(project.githubRepo, b.commit.sha, token);
              branchList.push({
                name: b.name,
                sha: b.commit.sha,
                commitMessage: commitData.commit.message.split("\n")[0] ?? null,
                commitAuthor: commitData.commit.author.name ?? null,
                commitAt: commitData.commit.author.date ?? null,
              });
            } catch {
              branchList.push({ name: b.name, sha: b.commit.sha, commitMessage: null, commitAuthor: null, commitAt: null });
            }
          }

          const watchBranch = project.autoDeployBranch;
          const watched = watchBranch ? branchList.find((b) => b.name === watchBranch) : null;

          if (watched) {
            const shortSha = watched.sha.slice(0, 7);
            db.prepare(
              "UPDATE projects SET last_commit_sha = ?, last_commit_message = ?, last_commit_author = ?, last_commit_at = ?, branches_json = ?, updated_at = ? WHERE id = ?"
            ).run(watched.sha, watched.commitMessage, watched.commitAuthor, watched.commitAt, JSON.stringify(branchList), now, project.id);

            if (watched.sha !== project.lastCommitSha && project.lastCommitSha !== null) {
              outputLines.push(`${prefix} NEW commit on ${watchBranch}: ${shortSha} — ${watched.commitMessage ?? "—"} → deploy triggered`);
              void this.triggerDeploy(project.id, { name: watchBranch as string, sha: watched.sha, commitMessage: watched.commitMessage, commitAuthor: watched.commitAuthor, commitAt: watched.commitAt });
            } else if (project.lastCommitSha === null) {
              outputLines.push(`${prefix} First poll on ${watchBranch}: ${shortSha} stored (no deploy)`);
            } else {
              outputLines.push(`${prefix} No new commits on ${watchBranch} (${shortSha})`);
            }
          } else {
            // Still store branch list even without a watch branch
            db.prepare(
              "UPDATE projects SET branches_json = ?, updated_at = ? WHERE id = ?"
            ).run(JSON.stringify(branchList), now, project.id);

            if (watchBranch) {
              outputLines.push(`${prefix} Branch "${watchBranch}" not found in repo`);
            } else {
              outputLines.push(`${prefix} No auto-deploy branch set`);
            }
          }

          // Push updated project to any subscribed clients
          const updatedRow = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id) as ProjectRow | undefined;
          if (updatedRow) {
            emitProjectDataUpdate(project.id, rowToProject(updatedRow));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputLines.push(`${prefix} ERROR: ${msg}`);
        }
      }

      const output = outputLines.join("\n");
      db.prepare(
        "UPDATE github_poller_config SET last_polled_at = ?, last_error = NULL, last_poll_output = ? WHERE id = 1"
      ).run(now, output);
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

  private async triggerDeploy(projectId: number, commit: GitHubBranch): Promise<void> {
    const db = getDatabase();
    const now = new Date().toISOString();
    const deployRow = db.prepare(
      "INSERT INTO project_deploys (project_id, commit_sha, commit_message, commit_author, triggered_by, status, created_at) VALUES (?, ?, ?, ?, 'auto', 'running', ?)"
    ).run(projectId, commit.sha, commit.commitMessage, commit.commitAuthor, now);
    const deployId = deployRow.lastInsertRowid as number;

    try {
      const result = await deployProject(projectId, "auto");
      const completed = new Date().toISOString();
      db.prepare(
        "UPDATE project_deploys SET status = ?, completed_at = ? WHERE id = ?"
      ).run(result.ok ? "success" : "failed", completed, deployId);
    } catch {
      db.prepare(
        "UPDATE project_deploys SET status = 'failed', completed_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), deployId);
    }
  }
}

export const githubPoller = new GitHubPoller();
