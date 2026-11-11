import { getDatabase } from "../../config/database";
import { defaultGithubClient, GithubClient, GithubError } from "./client";
import { GithubAppError, installationToken } from "./app";
import { getInstallation, listRepositories, type RepositoryRecord } from "./store";

/**
 * Which repository a project deploys through the App (Phase B). A project is bound to a repository *id* and to
 * the installation that exposes it, never to a name alone: two installations can each have a repository called
 * `api`, and a repository can be renamed.
 *
 * A project that does not use the App keeps `github_auth_mode = NULL` and its token exactly as before. Moving a
 * project to the App is reversible: the token it had stays on the project, and there is no silent fallback to it.
 */

export interface AppRepository { installationId: number; repositoryId: number; fullName: string; defaultBranch: string | null }

/** The repository, if the App can use it: its installation is linked and it is currently granted. */
export function resolveAppRepository(installationId: unknown, repositoryId: unknown): AppRepository {
  if (!Number.isInteger(installationId) || !Number.isInteger(repositoryId)) throw new GithubAppError("Choose an installation and a repository.");
  const installation = getInstallation(installationId as number);
  if (!installation || installation.status !== "linked") throw new GithubAppError("That installation is not connected to Stackport.", 403);
  const repository = listRepositories(installation.installationId).find((r) => r.repositoryId === repositoryId);
  if (!repository) throw new GithubAppError("The App does not have access to that repository. Refresh the installation's repositories, or grant it access on GitHub.", 404);
  return { installationId: repository.installationId, repositoryId: repository.repositoryId, fullName: repository.fullName, defaultBranch: repository.defaultBranch };
}

export function bindProjectToApp(projectId: number, repository: AppRepository): void {
  getDatabase().prepare("UPDATE projects SET github_auth_mode = 'app', github_repository_id = ?, github_installation_id = ?, github_repo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(repository.repositoryId, repository.installationId, repository.fullName, projectId);
}

/** Back to the token the project had. The credential columns were never touched, so nothing is lost. */
export function unbindProjectFromApp(projectId: number): void {
  getDatabase().prepare("UPDATE projects SET github_auth_mode = NULL, github_repository_id = NULL, github_installation_id = NULL, github_pending_ci_sha = NULL, github_pending_ci_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(projectId);
}

/** Granted repositories whose name matches (case-insensitive), across every linked installation. More than one
 *  means the admin has to choose. */
export function candidatesForRepo(fullName: string): RepositoryRecord[] {
  const wanted = fullName.trim().toLowerCase();
  return listRepositories().filter((r) => r.fullName.toLowerCase() === wanted && getInstallation(r.installationId)?.status === "linked");
}

/** A project's App credentials, read by the resolver. */
export interface ProjectAppBinding { mode: "app" | null; installationId: number | null; repositoryId: number | null; repo: string | null }

export function getProjectBinding(projectId: number): ProjectAppBinding | null {
  const row = getDatabase().prepare("SELECT github_auth_mode AS mode, github_installation_id AS installationId, github_repository_id AS repositoryId, github_repo AS repo FROM projects WHERE id = ?")
    .get(projectId) as { mode: string | null; installationId: number | null; repositoryId: number | null; repo: string | null } | undefined;
  return row ? { mode: row.mode === "app" ? "app" : null, installationId: row.installationId, repositoryId: row.repositoryId, repo: row.repo } : null;
}

/**
 * The installation token for a project bound to the App. It throws, with a reason, when the binding no longer holds:
 * the installation was suspended or removed, or the repository left the installation's grant. It never falls back
 * to the project's token, because a quiet fallback would hide that the App stopped working.
 */
export async function appTokenForProject(projectId: number, client: GithubClient = defaultGithubClient()): Promise<string> {
  const binding = getProjectBinding(projectId);
  if (!binding || binding.mode !== "app" || binding.installationId === null || binding.repositoryId === null) throw new GithubAppError("This project does not use the GitHub App.", 400);
  const repository = listRepositories(binding.installationId).find((r) => r.repositoryId === binding.repositoryId);
  if (!repository) throw new GithubAppError("The GitHub App no longer has access to this repository. Grant it access on GitHub, or move the project back to a token.", 403);
  return installationToken(binding.installationId, client);
}

/** Proves the App can read the repository, with a real call, before a project is moved onto it. */
export async function verifyRepositoryAccess(repository: AppRepository, client: GithubClient = defaultGithubClient()): Promise<void> {
  const token = await installationToken(repository.installationId, client);
  try {
    await client.request({ path: `/repos/${repository.fullName}`, bearer: token });
  } catch (err) {
    if (err instanceof GithubError) throw new GithubAppError(`GitHub would not let the App read ${repository.fullName}: ${err.message}`, 403);
    throw err;
  }
}

// ---- what the wizard reads before anything is cloned

export interface RepositoryBranch { name: string; sha: string }

export async function listRepositoryBranches(repository: AppRepository, client: GithubClient = defaultGithubClient()): Promise<RepositoryBranch[]> {
  const token = await installationToken(repository.installationId, client);
  const branches: RepositoryBranch[] = [];
  for (let page = 1; page <= 10; page++) {
    const { body } = await client.request<{ name: string; commit: { sha: string } }[]>({ path: `/repos/${repository.fullName}/branches?per_page=100&page=${page}`, bearer: token });
    for (const b of body) branches.push({ name: b.name, sha: b.commit.sha });
    if (body.length < 100) break;
  }
  return branches;
}

export interface RepositoryInspection {
  composeFiles: string[];
  /** Names only, from `.env.example` and its variants. The values are never read into Stackport's output. */
  envVariableNames: string[];
  truncated: boolean;
}

// eslint-disable-next-line security/detect-unsafe-regex -- measured: linear on a 140 000 character adversarial path (under 0.3 ms); the path comes from the repository.
const COMPOSE_NAME = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/i;
const MAX_FILES = 20;

/** Looks at a branch before cloning: which Compose files it has, and the variable *names* an `.env.example` lists. */
export async function inspectRepository(repository: AppRepository, branch: string, client: GithubClient = defaultGithubClient()): Promise<RepositoryInspection> {
  const token = await installationToken(repository.installationId, client);
  const { body: tree } = await client.request<{ tree: { path: string; type: string }[]; truncated?: boolean }>({
    path: `/repos/${repository.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, bearer: token,
  });
  const files = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
  const composeFiles = files.filter((path) => COMPOSE_NAME.test(path)).slice(0, MAX_FILES);
  const envFile = files.find((path) => ENV_EXAMPLE.test(path) && !path.includes("/node_modules/"));
  const names = new Set<string>();
  if (envFile) {
    const { body } = await client.request<{ content?: string; encoding?: string }>({ path: `/repos/${repository.fullName}/contents/${envFile.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, bearer: token });
    if (body.encoding === "base64" && typeof body.content === "string") {
      for (const line of Buffer.from(body.content, "base64").toString("utf8").split(/\r?\n/)) {
        // eslint-disable-next-line security/detect-unsafe-regex -- measured: linear on a 140 000 character adversarial line (under 0.5 ms); the line comes from the repository.
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match) names.add(match[1]);
      }
    }
  }
  return { composeFiles, envVariableNames: [...names].slice(0, 200), truncated: tree.truncated === true };
}
