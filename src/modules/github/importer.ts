import { getDatabase } from "../../config/database";
import { logger } from "../../shared/logger";
import { reserveHostnameForProject } from "../ingress/managedDomains";
import { createProject } from "../projects/operations";
import type { Project } from "../projects/types";
import { GithubAppError } from "./app";
import { bindProjectToApp, inspectRepository, resolveAppRepository, type AppRepository } from "./binding";
import { defaultGithubClient, GithubClient } from "./client";
import { getInstallation, listRepositories } from "./store";

/**
 * Creating projects from the repositories the GitHub App can use: one at a time (the MCP tool) or several at once (bulk
 * import). A project is created bound to the repository by id, on its default branch. Nothing is cloned or deployed: the
 * project exists, ready to be deployed or configured, and the admin decides when anything runs.
 */

/** Who can push to a connected repository controls what runs on this host once it is deployed. */
export const IMPORT_WARNING = "Anyone who can push to this repository controls what runs on this host once the project is deployed.";

/** A project name that is not already taken: the repository's name, then name-2, name-3. */
export function uniqueProjectName(wanted: string): string {
  const db = getDatabase();
  const taken = (name: string): boolean => !!db.prepare("SELECT 1 FROM projects WHERE lower(name) = lower(?)").get(name);
  const base = wanted.trim().slice(0, 90) || "project";
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now()}`;
}

/** The project that already deploys this repository through the App, if any. */
export function projectForRepository(repositoryId: number): { id: number; name: string } | null {
  const row = getDatabase().prepare("SELECT id, name FROM projects WHERE github_auth_mode = 'app' AND github_repository_id = ?").get(repositoryId) as { id: number; name: string } | undefined;
  return row ?? null;
}

export function createAppProject(repository: AppRepository, options: { name?: string; groupName?: string | null } = {}): Project {
  const repoName = repository.fullName.split("/")[1] ?? repository.fullName;
  const project = createProject({ name: uniqueProjectName(options.name ?? repoName), sourceType: "github", githubRepo: repository.fullName, autoDeployBranch: repository.defaultBranch, groupName: options.groupName ?? null });
  bindProjectToApp(project.id, repository);
  // With a default managed domain the project reserves <name>.<domain>; a failure there never fails the creation.
  try { reserveHostnameForProject(project.id, project.name); }
  catch (err) { logger.warn({ err, projectId: project.id }, "github-app: could not reserve a hostname for an imported project"); }
  return project;
}

// ---- bulk import

export interface ScanEntry {
  repositoryId: number;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  archived: boolean;
  composeFiles: string[];
  /** The project that already deploys it, so it is not imported twice. */
  importedAs: { id: number; name: string } | null;
  /** Why it cannot be scanned or imported, when it cannot. */
  note: string | null;
}

/** At most this many repositories are looked at in one scan: each costs two calls to GitHub. */
export const MAX_SCAN = 100;
export const MAX_IMPORT = 50;

/** For each repository an installation exposes: does its default branch have a Compose file, and is it already a project? */
export async function scanInstallation(installationId: number, client: GithubClient = defaultGithubClient()): Promise<{ entries: ScanEntry[]; truncated: boolean }> {
  const installation = getInstallation(installationId);
  if (!installation || installation.status !== "linked") throw new GithubAppError("That installation is not connected to Stackport.", 403);
  const repositories = listRepositories(installationId);
  const entries: ScanEntry[] = [];
  for (const repository of repositories.slice(0, MAX_SCAN)) {
    const base = { repositoryId: repository.repositoryId, fullName: repository.fullName, defaultBranch: repository.defaultBranch, isPrivate: repository.isPrivate, archived: repository.archived, importedAs: projectForRepository(repository.repositoryId) };
    if (!repository.defaultBranch) { entries.push({ ...base, composeFiles: [], note: "It has no default branch (an empty repository)." }); continue; }
    try {
      const found = await inspectRepository({ installationId, repositoryId: repository.repositoryId, fullName: repository.fullName, defaultBranch: repository.defaultBranch }, repository.defaultBranch, client, { readEnv: false });
      entries.push({ ...base, composeFiles: found.composeFiles, note: found.composeFiles.length === 0 ? "No Compose file on the default branch." : null });
    } catch (err) {
      entries.push({ ...base, composeFiles: [], note: `Could not be read: ${err instanceof Error ? err.message : "GitHub error"}.` });
    }
  }
  return { entries, truncated: repositories.length > MAX_SCAN };
}

export interface ImportOutcome { repositoryId: number; fullName: string | null; status: "created" | "skipped"; reason?: string; project?: { id: number; name: string } }

/** Creates a project for each chosen repository that has a Compose file and is not a project yet. Each is checked on its own:
 *  one that cannot be imported says why and does not stop the others. */
export async function importRepositories(installationId: number, repositoryIds: unknown, groupName: string | null = null, client: GithubClient = defaultGithubClient()): Promise<ImportOutcome[]> {
  if (!Array.isArray(repositoryIds) || repositoryIds.length === 0) throw new GithubAppError("Choose at least one repository.");
  if (repositoryIds.length > MAX_IMPORT) throw new GithubAppError(`Import at most ${MAX_IMPORT} repositories at a time.`);
  const outcomes: ImportOutcome[] = [];
  for (const id of [...new Set(repositoryIds)]) {
    if (!Number.isInteger(id)) { outcomes.push({ repositoryId: Number(id), fullName: null, status: "skipped", reason: "Not a repository id." }); continue; }
    let repository: AppRepository;
    try { repository = resolveAppRepository(installationId, id); }
    catch (err) { outcomes.push({ repositoryId: id as number, fullName: null, status: "skipped", reason: err instanceof Error ? err.message : "Not available." }); continue; }
    const existing = projectForRepository(repository.repositoryId);
    if (existing) { outcomes.push({ repositoryId: repository.repositoryId, fullName: repository.fullName, status: "skipped", reason: `Already the project "${existing.name}".` }); continue; }
    if (!repository.defaultBranch) { outcomes.push({ repositoryId: repository.repositoryId, fullName: repository.fullName, status: "skipped", reason: "It has no default branch." }); continue; }
    try {
      const found = await inspectRepository(repository, repository.defaultBranch, client, { readEnv: false });
      if (found.composeFiles.length === 0) { outcomes.push({ repositoryId: repository.repositoryId, fullName: repository.fullName, status: "skipped", reason: "No Compose file on the default branch." }); continue; }
      const project = createAppProject(repository, { groupName });
      outcomes.push({ repositoryId: repository.repositoryId, fullName: repository.fullName, status: "created", project: { id: project.id, name: project.name } });
    } catch (err) {
      outcomes.push({ repositoryId: repository.repositoryId, fullName: repository.fullName, status: "skipped", reason: err instanceof Error ? err.message : "It could not be imported." });
    }
  }
  return outcomes;
}
