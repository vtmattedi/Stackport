import path from "path";
import { existsSync, readFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config/env";

const exec = promisify(execFile);

export interface CommitInfo {
  sha: string;
  shortSha: string;
  date: string | null;
  message: string;
}

/** One version for the whole app: the client and API ship in the same image. */
export interface AppVersion {
  version: string;
  commit: CommitInfo | null;
}

export interface UpdateCheck {
  ok: boolean;
  error: string | null;
  /** The branch this server updates from (stable unless install chose another). */
  branch: string;
  current: CommitInfo | null;
  /** Commits on `branch` newer than the running one: what Update would install. */
  available: CommitInfo[];
  /** Commits on main not yet promoted to stable, i.e. still waiting on (or failed) CI. */
  pending: CommitInfo[];
  /** Base URL for commit links when the repository is on GitHub. */
  commitUrl: string | null;
  checkedAt: string;
}

const LIST_LIMIT = 20;
const RELEASE_BRANCH = "stable";
const DEVELOPMENT_BRANCH = "main";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The running commit. stackport.sh bakes it into the image (STACKPORT_COMMIT build
 *  arg) and also writes it to the generated .env, which covers older images. */
export function runningSha(): string | null {
  const sha = process.env["STACKPORT_COMMIT"]?.trim();
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

export function updateBranch(): string {
  return process.env["GIT_BRANCH"]?.trim() || RELEASE_BRANCH;
}

function repoUrl(): string | null {
  const repo = process.env["APP_GITHUB_REPO"] ?? process.env["GITHUB_REPO"] ?? process.env["STACKPORT_REPO_URL"];
  if (!repo) return null;
  if (/^(https?|file|ssh):\/\//.test(repo) || repo.startsWith("git@") || repo.startsWith("/")) return repo;
  return `https://github.com/${repo}.git`;
}

function githubCommitUrl(url: string | null): string | null {
  const match = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/commit/` : null;
}

/** A blobless mirror of the release and development branches, kept next to the
 *  database so later checks only fetch what's new. */
function cacheDir(): string {
  return path.join(path.dirname(path.resolve(config.sqlitePath)), "update-cache.git");
}

async function git(args: string[], timeout = 15_000): Promise<string> {
  const {stdout} = await exec("git", ["--git-dir", cacheDir(), ...args], {timeout, maxBuffer: 4 * 1024 * 1024});
  return stdout;
}

const FORMAT = "%H%x1f%cI%x1f%s";

function parseLog(stdout: string): CommitInfo[] {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, date, message] = line.split("\x1f");
    return {sha, shortSha: sha.slice(0, 7), date: date || null, message: message ?? ""};
  });
}

async function log(revisions: string[]): Promise<CommitInfo[]> {
  return parseLog(await git(["log", `--format=${FORMAT}`, `--max-count=${LIST_LIMIT}`, ...revisions, "--"]));
}

async function describe(sha: string): Promise<CommitInfo> {
  try {
    const [commit] = parseLog(await git(["log", "-1", `--format=${FORMAT}`, sha, "--"]));
    if (commit) return commit;
  } catch { /* Not in the cache yet. */ }
  return {sha, shortSha: sha.slice(0, 7), date: null, message: ""};
}

async function hasRef(ref: string): Promise<boolean> {
  try { await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return true; }
  catch { return false; }
}

export async function getAppVersion(): Promise<AppVersion> {
  const sha = runningSha();
  return {version: packageVersion(), commit: sha ? await describe(sha) : null};
}

let inFlight: Promise<UpdateCheck> | null = null;

/** Fetches the release and development branches and lists what this server could
 *  install now and what is still waiting to be promoted. Concurrent callers share
 *  one fetch, since two writers in the same git dir would trip over each other. */
export function checkForUpdates(authHeader: string | null): Promise<UpdateCheck> {
  inFlight ??= runCheck(authHeader).finally(() => { inFlight = null; });
  return inFlight;
}

async function runCheck(authHeader: string | null): Promise<UpdateCheck> {
  const branch = updateBranch();
  const url = repoUrl();
  const sha = runningSha();
  const result: UpdateCheck = {
    ok: false, error: null, branch, current: sha ? await describe(sha) : null,
    available: [], pending: [], commitUrl: githubCommitUrl(url), checkedAt: new Date().toISOString(),
  };
  if (!url) {
    result.error = "Stackport's repository is not configured. Run 'sudo stackport repair' on the server.";
    return result;
  }

  try {
    if (!existsSync(cacheDir())) await exec("git", ["init", "--quiet", "--bare", cacheDir()]);
    const refspecs = [...new Set([branch, DEVELOPMENT_BRANCH])].map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
    const token = process.env["STACKPORT_REPO_TOKEN"];
    const header = authHeader ?? (token ? `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` : null);
    await git([...(header ? ["-c", `http.extraHeader=${header}`] : []),
      "fetch", "--quiet", "--no-tags", "--filter=blob:none", "--prune", url, ...refspecs], 120_000);
  } catch (error) {
    const stderr = String((error as {stderr?: string}).stderr ?? "").trim();
    result.error = stderr.split("\n").pop() || "Cannot reach Stackport's repository.";
    return result;
  }

  const release = `refs/remotes/origin/${branch}`;
  if (!await hasRef(release)) {
    result.error = `The repository has no ${branch} branch yet.`;
    return result;
  }
  // A running commit the cache doesn't know (e.g. a local build) can't be compared.
  const known = sha !== null && await hasRef(sha);
  if (sha) result.current = await describe(sha);
  if (known) result.available = await log([release, `^${sha}`]);
  const development = `refs/remotes/origin/${DEVELOPMENT_BRANCH}`;
  if (branch !== DEVELOPMENT_BRANCH && await hasRef(development)) {
    result.pending = await log([development, `^${release}`, ...(known ? [`^${sha}`] : [])]);
  }
  result.ok = true;
  return result;
}
