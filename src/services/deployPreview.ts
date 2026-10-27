import type { Project } from "../entities/Project";
import { githubApiGet, tokenForProject } from "./githubPoller";
import { getActiveDeployment, resolveRollbackTarget } from "./projectDeployments";
import { diffLines, type LineDiff } from "./textDiff";

/** What a deploy or rollback would change, shown before it runs: the commits between
 *  the running revision and the target (from GitHub's compare API), and a diff of the
 *  Compose file. Read-only: nothing here touches the checkout, so a preview can run
 *  while another action holds the project. */

/** GitHub returns up to 250 commits, oldest first; the preview keeps the newest. */
const MAX_COMMITS = 50;

/** Replaceable in tests. */
export interface PreviewDeps { get: (path: string, token: string | null) => Promise<unknown> }
const defaultDeps: PreviewDeps = { get: githubApiGet };

export interface PreviewCommit {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface PreviewRevision {
  sha: string | null;
  branch: string | null;
  composeFileName: string | null;
}

export interface CommitComparison {
  /** From GitHub: the target relative to the running revision. */
  status: "ahead" | "behind" | "diverged" | "identical";
  /** Commits the target has that the running revision doesn't (newest last), capped. */
  added: PreviewCommit[];
  addedTotal: number;
  /** Commits the running revision has that the target doesn't, capped. */
  removed: PreviewCommit[];
  removedTotal: number;
}

export interface ComposePreview {
  fromFile: string | null;
  toFile: string | null;
  /** Which version of the file is compared: the repository file as committed, or the
   *  file Stackport wrote and ran (with its network additions). */
  basis: "source" | "effective";
  diff: LineDiff;
}

export interface RevisionPreview {
  from: PreviewRevision | null;
  to: PreviewRevision;
  commits: CommitComparison | null;
  /** Why there is no commit comparison (no repository, no running revision, GitHub error). */
  commitsNote: string | null;
  compose: ComposePreview | null;
  composeNote: string | null;
}

interface GitHubCompareCommit {
  sha: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
}

interface GitHubCompare {
  status: CommitComparison["status"];
  ahead_by: number;
  behind_by: number;
  merge_base_commit?: { sha: string };
  commits: GitHubCompareCommit[];
}

function toCommit(c: GitHubCompareCommit): PreviewCommit {
  return {
    sha: c.sha,
    message: c.commit.message.split("\n")[0] ?? "",
    author: c.commit.author?.name ?? null,
    date: c.commit.author?.date ?? null,
  };
}

/** Branch names may contain "/"; GitHub wants those kept, so only the segments are encoded. */
function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

async function compare(deps: PreviewDeps, project: Project, base: string, head: string): Promise<GitHubCompare> {
  const body = await deps.get(
    `/repos/${project.githubRepo}/compare/${refPath(base)}...${refPath(head)}`,
    tokenForProject(project),
  ) as GitHubCompare;
  if (!body || !Array.isArray(body.commits)) throw new Error("Unexpected response from GitHub");
  return body;
}

function lastCommits(list: GitHubCompareCommit[]): PreviewCommit[] {
  return list.slice(-MAX_COMMITS).map(toCommit);
}

/** GitHub errors end with the raw response body; the status and hint are enough here. */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/:\s*\{[\s\S]*$/, "");
}

function errorNote(err: unknown): string {
  return `Couldn't compare commits: ${errorText(err)}`;
}

interface GitHubContent { type?: string; encoding?: string; content?: string }

async function fetchFileAt(deps: PreviewDeps, project: Project, file: string, ref: string): Promise<string> {
  const body = await deps.get(
    `/repos/${project.githubRepo}/contents/${refPath(file)}?ref=${encodeURIComponent(ref)}`,
    tokenForProject(project),
  ) as GitHubContent;
  if (body?.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
    throw new Error(`${file} isn't a regular file on ${ref}`);
  }
  return Buffer.from(body.content, "base64").toString("utf8");
}

/** A deploy of `branch` (or the project's auto-deploy branch). Compares commits from
 *  the running revision to the branch head, and the running revision's Compose source
 *  with the same file on the branch. */
export async function previewDeploy(project: Project, branch: string | null, deps: PreviewDeps = defaultDeps): Promise<RevisionPreview> {
  const targetBranch = branch ?? project.autoDeployBranch;
  const active = getActiveDeployment(project.id);
  const from: PreviewRevision | null = active
    ? { sha: active.commitSha, branch: active.branch, composeFileName: active.composeFileName }
    : null;
  const to: PreviewRevision = { sha: null, branch: targetBranch, composeFileName: project.composeFile };
  const result: RevisionPreview = { from, to, commits: null, commitsNote: null, compose: null, composeNote: null };

  if (!project.githubRepo) {
    result.commitsNote = "This project has no GitHub repository.";
    return result;
  }
  if (!targetBranch) {
    result.commitsNote = "No branch selected and no auto-deploy branch configured.";
    return result;
  }

  if (!from?.sha) {
    result.commitsNote = "Nothing has been deployed yet, so there is nothing to compare with.";
  } else {
    try {
      const cmp = await compare(deps, project, from.sha, targetBranch);
      // When the branch is behind, its head is the merge base; otherwise the last commit.
      to.sha = cmp.commits.length > 0 ? cmp.commits[cmp.commits.length - 1].sha
        : cmp.status === "identical" ? from.sha : cmp.merge_base_commit?.sha ?? null;
      let removed: PreviewCommit[] = [];
      if (cmp.behind_by > 0) {
        try { removed = lastCommits((await compare(deps, project, targetBranch, from.sha)).commits); } catch { /* the count is enough */ }
      }
      result.commits = { status: cmp.status, added: lastCommits(cmp.commits), addedTotal: cmp.ahead_by, removed, removedTotal: cmp.behind_by };
    } catch (err) {
      result.commitsNote = errorNote(err);
    }
  }

  const file = project.composeFile;
  if (result.commitsNote?.startsWith("Couldn't compare")) {
    // The file comes from the same API; don't report the same failure twice.
    result.composeNote = "No Compose diff: GitHub couldn't be reached.";
  } else if (!file) {
    result.composeNote = "No Compose file selected.";
  } else if (active?.sourceCompose == null) {
    result.composeNote = "No recorded Compose file for the running revision.";
  } else {
    try {
      const next = await fetchFileAt(deps, project, file, to.sha ?? targetBranch);
      result.compose = { fromFile: active.composeFileName, toFile: file, basis: "source", diff: diffLines(active.sourceCompose, next) };
    } catch (err) {
      result.composeNote = `Couldn't read ${file} from GitHub: ${errorText(err)}`;
    }
  }
  return result;
}

export type RollbackPreview = { ok: true; preview: RevisionPreview; targetId: number } | { ok: false; error: string };

/** A rollback to `deploymentId` (or the default target). Compares commits from the
 *  running revision to the target, and the Compose files exactly as each one ran. */
export async function previewRollback(project: Project, deploymentId?: number, deps: PreviewDeps = defaultDeps): Promise<RollbackPreview> {
  const resolved = resolveRollbackTarget(project.id, deploymentId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const target = resolved.target;
  const active = getActiveDeployment(project.id);
  const from: PreviewRevision | null = active
    ? { sha: active.commitSha, branch: active.branch, composeFileName: active.composeFileName }
    : null;
  const to: PreviewRevision = { sha: target.commitSha, branch: target.branch, composeFileName: target.composeFileName };
  const preview: RevisionPreview = { from, to, commits: null, commitsNote: null, compose: null, composeNote: null };

  if (!project.githubRepo) {
    preview.commitsNote = "This project has no GitHub repository.";
  } else if (!from?.sha || !to.sha) {
    preview.commitsNote = "The running revision has no recorded commit.";
  } else if (from.sha === to.sha) {
    preview.commits = { status: "identical", added: [], addedTotal: 0, removed: [], removedTotal: 0 };
  } else {
    try {
      const back = await compare(deps, project, to.sha, from.sha);
      let added: PreviewCommit[] = [];
      if (back.behind_by > 0) {
        try { added = lastCommits((await compare(deps, project, from.sha, to.sha)).commits); } catch { /* the count is enough */ }
      }
      const status: CommitComparison["status"] = back.status === "ahead" ? "behind" : back.status === "behind" ? "ahead" : back.status;
      preview.commits = { status, added, addedTotal: back.behind_by, removed: lastCommits(back.commits), removedTotal: back.ahead_by };
    } catch (err) {
      preview.commitsNote = errorNote(err);
    }
  }

  if (active?.effectiveCompose == null || target.effectiveCompose == null) {
    preview.composeNote = "No recorded Compose file for the running revision.";
  } else {
    preview.compose = {
      fromFile: active.composeFileName,
      toFile: target.composeFileName,
      basis: "effective",
      diff: diffLines(active.effectiveCompose, target.effectiveCompose),
    };
  }
  return { ok: true, preview, targetId: target.id };
}
