import { execFile, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config/env";
import { getDatabase } from "../config/database";
import { rowToProject, type Project, type ProjectRow } from "../entities/Project";
import { decryptSecret } from "../utils/crypto";
import { normalizeRelativePath, resolveContainedPath } from "../utils/safePath";
import { emitProjectDeploy, type ProjectDeployEvent } from "./realtime";
import { actionRegistry, projectRepoKey } from "./actionRegistry";
import { loadYamlDoc } from "./composeYaml";
import { validateComposePolicy } from "./composePolicy";
import { applyStackportProxyNetwork } from "./composeNetworking";
import { listRoutedServiceNames } from "./projectDomains";
import { ensureBuildCapacity } from "./dockerStorage";
import { recordFailedDeployment, recordSuccessfulDeployment, getPreviousSuccessfulDeployment } from "./projectDeployments";
import { notifyDeployBlocked } from "./notificationService";
import { invalidateContainers } from "./dockerStatusCache";

export interface EnvVariable {
  key: string;
  value: string;
}

export interface ProjectEnvFile {
  id: number;
  projectId: number;
  relativePath: string;
  variables: EnvVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEnvFileRow {
  id: number;
  project_id: number;
  relative_path: string;
  variables_json: string;
  created_at: string;
  updated_at: string;
}

export interface DeployResult {
  ok: boolean;
  projectId: number;
  repoPath: string;
  output: string;
  action: "build" | "deploy" | "stop" | "stop-purge" | "pull" | "compose" | "upload" | "recreate" | "force-rebuild" | "redeploy-service" | "drop-volumes";
}

export interface ProjectRepoFolderScanProject {
  projectId: number;
  name: string;
  githubRepo: string | null;
  expectedFolder: string;
  expectedPath: string;
}

export interface ProjectRepoFolderScanFolder {
  folder: string;
  path: string;
  projectId: number | null;
  projectName: string | null;
  githubRepo: string | null;
  expectedFolder: string | null;
  status: "matched" | "name-mismatch" | "no-project" | "unparseable";
  hasCompose: boolean;
}

export interface ProjectRepoFolderScanResult {
  deployRoot: string;
  folders: ProjectRepoFolderScanFolder[];
  missingProjectFolders: ProjectRepoFolderScanProject[];
  orphanFolders: ProjectRepoFolderScanFolder[];
  nameMismatches: ProjectRepoFolderScanFolder[];
}

interface RunResult {
  ok: boolean;
  output: string;
  stdout: string;
  command: string;
}

interface ComposeCommand {
  cmd: string;
  argsPrefix: string[];
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deployRoot(): string {
  return path.resolve(config.deployRoot);
}

export function projectRepoDir(project: Pick<Project, "id" | "name">): string {
  return path.join(deployRoot(), expectedComposeProjectName(project));
}

function dockerConfigDir(): string {
  return path.join(deployRoot(), ".docker");
}

function dockerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DOCKER_CONFIG: process.env["DOCKER_CONFIG"] ?? dockerConfigDir() };
}

export function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function expectedComposeProjectName(project: Pick<Project, "id" | "name">): string {
  return `${project.id}-${slugify(project.name)}`;
}

function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function gitArgs(authHeader: string | null, args: string[]): string[] {
  return authHeader ? ["-c", `http.extraHeader=${authHeader}`, ...args] : args;
}

function publicGitArgs(args: string[]): string[] {
  if (args[0] === "-c" && args[1]?.startsWith("http.extraHeader=")) return args.slice(2);
  return args;
}

function gitAuthHeader(project: Project): string | null {
  const credentialId = project.githubCredentialId;
  const row = getDatabase()
    .prepare(credentialId
      ? "SELECT username, secret_enc FROM credentials WHERE id = ? AND type = 'github'"
      : "SELECT username, secret_enc FROM credentials WHERE type = 'github' AND is_default = 1 LIMIT 1")
    .get(...(credentialId ? [credentialId] : [])) as { username: string | null; secret_enc: string } | undefined;
  if (!row?.username) return null;
  const token = decryptSecret(row.secret_enc);
  return `Authorization: Basic ${Buffer.from(`${row.username}:${token}`).toString("base64")}`;
}

function emit(projectId: number, action: ProjectDeployEvent["action"], stream: ProjectDeployEvent["stream"], message: string, extra: Partial<ProjectDeployEvent> = {}): void {
  emitProjectDeploy({ projectId, action, stream, message, ...extra });
}

function run(
  projectId: number,
  action: ProjectDeployEvent["action"],
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; publicArgs?: string[]; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const publicCommand = [cmd, ...(options.publicArgs ?? args)].join(" ");
    const chunks: string[] = [`$ ${publicCommand}\n`];
    const stdoutChunks: string[] = [];
    emit(projectId, action, "status", `$ ${publicCommand}\n`);

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      shell: false,
      env: options.env ?? process.env,
    });

    actionRegistry.registerCanceler(projectRepoKey(projectId), () => child.kill("SIGTERM"));

    const timeout = windowlessTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      chunks.push(message);
      stdoutChunks.push(message);
      emit(projectId, action, "stdout", message);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      chunks.push(message);
      emit(projectId, action, "stderr", message);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      const message = `${err.message}\n`;
      chunks.push(message);
      emit(projectId, action, "stderr", message);
      resolve({ ok: false, output: chunks.join(""), stdout: stdoutChunks.join(""), command: publicCommand });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const ok = code === 0;
      const message = signal ? `Process stopped by ${signal}\n` : `Exit code ${code ?? 0}\n`;
      chunks.push(message);
      emit(projectId, action, "status", message);
      resolve({ ok, output: chunks.join(""), stdout: stdoutChunks.join(""), command: publicCommand });
    });
  });
}

function windowlessTimeout(fn: () => void, ms: number): NodeJS.Timeout {
  return setTimeout(fn, ms);
}

async function commandOk(cmd: string, args: string[]): Promise<boolean> {
  await fs.mkdir(dockerConfigDir(), { recursive: true });
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, env: dockerEnv() }, (err) => {
      resolve(!err);
    });
  });
}

async function composeCommand(): Promise<ComposeCommand> {
  if (await commandOk("docker", ["compose", "version"])) {
    return { cmd: "docker", argsPrefix: ["compose"] };
  }
  if (await commandOk("docker-compose", ["version"])) {
    return { cmd: "docker-compose", argsPrefix: [] };
  }
  return { cmd: "docker", argsPrefix: ["compose"] };
}

/** Phase 1.3 policy gate — only for commands that actually create/start containers
 *  (`up`) or dry-run what would (`config`, the upload path's pre-flight validation).
 *  `build`/`down`/`ps`/`rm` don't act on these directives at all, so re-checking there
 *  would be redundant. Reads the resolved file fresh (post Phase 1.7 network
 *  augmentation), matching the existing pattern in this file where each pass over a
 *  compose file re-reads independently rather than sharing one parsed doc. */
async function checkComposePolicy(repoPath: string, composeFile: string): Promise<{ ok: boolean; message: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoPath, composeFile), "utf8");
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}\n` };
  }
  let doc: unknown;
  try {
    doc = loadYamlDoc(raw);
  } catch {
    return { ok: true, message: "" }; // malformed YAML is a separate failure mode — let `docker compose` report it
  }
  const result = validateComposePolicy(doc);
  if (result.ok) return { ok: true, message: "" };
  return {
    ok: false,
    message: `Deployment rejected — compose policy violation:\n\n${result.violations.join("\n")}\n`,
  };
}

async function runCompose(
  projectId: number,
  action: ProjectDeployEvent["action"],
  repoPath: string,
  composeFile: string | null,
  args: string[],
  timeoutMs: number
): Promise<RunResult> {
  await fs.mkdir(dockerConfigDir(), { recursive: true });
  if (composeFile) {
    // Phase 1.7 — StackPort-owned augmentation, ephemeral (never committed, same
    // philosophy the old SP:AUTO/port-hiding rewrites used): attaches whichever
    // services this project's domains actually route to onto the shared
    // stackport-proxy network so nginx can reach them by service name. Re-applied on
    // every runCompose call because git operations (ensureRepo's reset --hard) wipe
    // it back to the plain source file on every fresh pull, same reason SP:AUTO
    // needed re-substitution before every invocation.
    const routedServices = listRoutedServiceNames(projectId);
    if (routedServices.length > 0) {
      const network = await applyStackportProxyNetwork(repoPath, composeFile, routedServices);
      if (!network.ok) {
        emit(projectId, action, "stderr", network.message);
        return { ok: false, output: network.message, stdout: "", command: "stackport-proxy network attachment" };
      }
    }

    if (args[0] === "up" || args[0] === "config") {
      const policy = await checkComposePolicy(repoPath, composeFile);
      if (!policy.ok) {
        emit(projectId, action, "stderr", policy.message);
        return { ok: false, output: policy.message, stdout: "", command: "compose policy check" };
      }
    }
  }
  const compose = await composeCommand();
  const fileArgs = composeFile ? ["-f", composeFile] : [];
  const result = await run(projectId, action, compose.cmd, [...compose.argsPrefix, ...fileArgs, ...args], {
    cwd: repoPath,
    timeoutMs,
    env: dockerEnv(),
  });
  // Choke point for every docker compose invocation in this file — `up`/`down` are
  // the only subcommands that can change the running container set or which compose
  // stacks exist (unlike `build`/`config`, which don't touch running containers), so
  // only invalidate for those. Runs regardless of ok/fail — a failed up/down can
  // still leave containers partially changed.
  if (args[0] === "up" || args[0] === "down") {
    invalidateContainers();
  }
  return result;
}

export function normalizeEnvRelativePath(input: string): string | null {
  const normalized = normalizeRelativePath(input);
  if (!normalized || !normalized.endsWith(".env")) return null;
  return normalized;
}

const COMPOSE_FILE_EXT_RE = /\.(ya?ml)$/i;
const DEFAULT_COMPOSE_PRIORITY = ["docker-compose.stackport.yml", "docker-compose.yml"];

/** Syntactic-only check (bare basename, .yml/.yaml extension, safe path segments) —
 *  does NOT verify the file actually exists; pair with validateComposeFileChoice for that. */
export function parseComposeFileName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalized = normalizeRelativePath(input);
  if (!normalized) return null;
  const basename = path.posix.basename(normalized);
  return COMPOSE_FILE_EXT_RE.test(basename) ? basename : null;
}

/** Top-level only (no recursion) — scans a repo checkout for compose-like files. */
export async function scanComposeFiles(repoPath: string): Promise<string[]> {
  const entries = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && COMPOSE_FILE_EXT_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** docker-compose.stackport.yml -> docker-compose.yml -> alphabetically first remaining candidate. */
export function resolveDefaultComposeFile(candidates: string[]): string | null {
  for (const name of DEFAULT_COMPOSE_PRIORITY) {
    if (candidates.includes(name)) return name;
  }
  return candidates[0] ?? null;
}

/** Validates a user-chosen filename against traversal AND against the real scanned candidate set. */
export function validateComposeFileChoice(chosen: string, candidates: string[]): string | null {
  const basename = path.posix.basename(normalizeRelativePath(chosen) ?? "");
  return basename && candidates.includes(basename) ? basename : null;
}

/** Every action other than a real pull just trusts the persisted choice — nothing on
 *  disk changes between pulls, so there's nothing to re-scan. syncAfterPull (below) is
 *  the only place that scans the filesystem and resolves/persists which file is active. */
function requireProjectComposeFile(project: Project): string | null {
  return project.composeFile;
}

// Deliberately doesn't end in .yml/.yaml, so scanComposeFiles (which only matches that
// extension) never offers it as a selectable compose file, and lives at the repo's top
// level (not a subdirectory) so its own directory is repoPath — same project-directory
// docker compose would already default to, no extra --project-directory flag needed.
const DEPLOYED_COMPOSE_SNAPSHOT = ".stackport-deployed-compose.snapshot";

/** Copies the resolved compose file — post {{SP:AUTO}} substitution and port-hiding,
 *  the exact bytes docker compose just used — to an untracked snapshot inside the repo
 *  right after a successful whole-stack `up`. `git reset --hard` (see ensureRepo) only
 *  ever touches tracked files, so this survives every future pull untouched. Lifecycle
 *  actions that must target whatever's *actually running* (stop, stop-purge, drop
 *  volumes, logs) read this snapshot instead of the live tracked file, so a later pull
 *  that renames/removes/edits a service can't make `docker compose down` miscompute
 *  what to stop and leave orphaned containers or target the wrong volumes. Only actions
 *  that re-run a whole-stack `up` (a real redeploy) refresh it. */
async function snapshotDeployedCompose(repoPath: string, composeFile: string): Promise<void> {
  try {
    await fs.copyFile(path.join(repoPath, composeFile), path.join(repoPath, DEPLOYED_COMPOSE_SNAPSHOT));
  } catch {
    // best-effort — a missing source file here would already have failed the up itself
  }
}

/** Prefers the last-deployed snapshot over the live tracked file — see
 *  snapshotDeployedCompose. Falls back to the live file when no snapshot exists yet
 *  (nothing has been successfully deployed via this mechanism for this checkout). */
async function resolveDeployedComposeFile(repoPath: string, project: Project): Promise<string | null> {
  const snapshotPath = path.join(repoPath, DEPLOYED_COMPOSE_SNAPSHOT);
  const hasSnapshot = await fs.access(snapshotPath).then(() => true).catch(() => false);
  return hasSnapshot ? DEPLOYED_COMPOSE_SNAPSHOT : requireProjectComposeFile(project);
}

export function parseEnvVariables(input: unknown): EnvVariable[] | null {
  if (!Array.isArray(input)) return null;
  const variables: EnvVariable[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const data = item as Record<string, unknown>;
    if (typeof data["key"] !== "string" || typeof data["value"] !== "string") return null;
    const key = data["key"].trim();
    if (data["value"].includes("\n") || data["value"].includes("\r")) return null;
    if (!ENV_KEY_RE.test(key)) return null;
    variables.push({ key, value: data["value"] });
  }

  const keys = new Set<string>();
  for (const variable of variables) {
    if (keys.has(variable.key)) return null;
    keys.add(variable.key);
  }

  return variables;
}

function rowToEnvFile(row: ProjectEnvFileRow): ProjectEnvFile {
  let variables: EnvVariable[] = [];
  try {
    const parsed = JSON.parse(row.variables_json) as unknown;
    variables = parseEnvVariables(parsed) ?? [];
  } catch {
    variables = [];
  }

  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    variables,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getProjectById(id: number): Project | null {
  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export async function scanProjectRepoFolders(): Promise<ProjectRepoFolderScanResult> {
  const root = deployRoot();
  const rows = getDatabase()
    .prepare("SELECT * FROM projects ORDER BY id ASC")
    .all() as ProjectRow[];
  const projects = rows.map(rowToProject);
  const projectsById = new Map(projects.map((project) => [project.id, project]));

  const entries = await fs.readdir(root, { withFileTypes: true }).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  });
  const folderNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const folderNameSet = new Set(folderNames);

  const folders = await Promise.all(folderNames.map(async (folder): Promise<ProjectRepoFolderScanFolder> => {
    const idMatch = /^(\d+)-.+$/.exec(folder);
    const projectId = idMatch ? Number(idMatch[1]) : null;
    const project = projectId != null ? projectsById.get(projectId) ?? null : null;
    const expectedFolder = project ? `${project.id}-${slugify(project.name)}` : null;
    const status: ProjectRepoFolderScanFolder["status"] =
      project && expectedFolder === folder
        ? "matched"
        : project
          ? "name-mismatch"
          : projectId == null
            ? "unparseable"
            : "no-project";

    const folderPath = path.join(root, folder);
    const hasCompose = await fs.access(path.join(folderPath, "docker-compose.yml"))
      .then(() => true)
      .catch(() => fs.access(path.join(folderPath, "compose.yml")).then(() => true).catch(() => false));

    return {
      folder,
      path: folderPath,
      projectId,
      projectName: project?.name ?? null,
      githubRepo: project?.githubRepo ?? null,
      expectedFolder,
      status,
      hasCompose,
    };
  }));

  const missingProjectFolders = projects
    .filter((project) => project.githubRepo)
    .map((project) => {
      const expectedFolder = `${project.id}-${slugify(project.name)}`;
      return {
        projectId: project.id,
        name: project.name,
        githubRepo: project.githubRepo,
        expectedFolder,
        expectedPath: path.join(root, expectedFolder),
      };
    })
    .filter((project) => !folderNameSet.has(project.expectedFolder));

  return {
    deployRoot: root,
    folders,
    missingProjectFolders,
    orphanFolders: folders.filter((folder) => folder.status === "no-project" || folder.status === "unparseable"),
    nameMismatches: folders.filter((folder) => folder.status === "name-mismatch"),
  };
}

/** Fixes a "name-mismatch" repo folder (see scanProjectRepoFolders) by renaming it on
 *  disk to the project's current expected folder name. projectRepoDir() derives the
 *  path fresh from project.id/name on every call rather than persisting it anywhere,
 *  so once the folder matches, every future action resolves correctly again with no
 *  other state to update.
 *
 *  Two things a plain `fs.rename` alone wouldn't handle, both addressed here:
 *  - Refuses to run if the target path already exists (e.g. a fresh clone already
 *    landed there after the project was renamed in the UI) — that's a real conflict
 *    for a human to resolve, not something to silently overwrite.
 *  - Docker container labels are baked in at creation time and don't follow a folder
 *    rename — any containers still running under the OLD folder's compose project
 *    name would become permanently invisible to every future stop/down issued from
 *    the new path. Best-effort tears them down by that old project name (addressed
 *    purely by name, no compose file needed) before renaming. */
export async function renameProjectRepoFolder(projectId: number, currentFolder: string): Promise<{ ok: boolean; message: string }> {
  const project = getProjectById(projectId);
  if (!project) return { ok: false, message: "Project not found." };

  const basename = path.basename(currentFolder);
  if (!currentFolder || basename !== currentFolder || currentFolder === "." || currentFolder === "..") {
    return { ok: false, message: "Invalid folder name." };
  }

  const expectedFolder = expectedComposeProjectName(project);
  if (currentFolder === expectedFolder) {
    return { ok: true, message: "Folder already matches the expected name." };
  }

  const root = deployRoot();
  const currentPath = path.join(root, currentFolder);
  const targetPath = path.join(root, expectedFolder);

  const currentStat = await fs.stat(currentPath).catch(() => null);
  if (!currentStat?.isDirectory()) {
    return { ok: false, message: `Folder "${currentFolder}" not found.` };
  }
  const targetExists = await fs.access(targetPath).then(() => true).catch(() => false);
  if (targetExists) {
    return { ok: false, message: `Target folder "${expectedFolder}" already exists — resolve that conflict manually before renaming.` };
  }

  const log: string[] = [];
  const compose = await composeCommand();
  const stop = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child = spawn(compose.cmd, [...compose.argsPrefix, "-p", currentFolder, "down"], { cwd: currentPath, shell: false, env: dockerEnv() });
    const chunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    child.stderr.on("data", (c: Buffer) => chunks.push(c.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, output: chunks.join("") }));
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
  });
  log.push(stop.ok
    ? `Stopped any containers still running under the old project name "${currentFolder}".`
    : `No containers to stop under "${currentFolder}" (or stop failed): ${stop.output.trim() || "unknown error"}`);

  await fs.rename(currentPath, targetPath);
  log.push(`Renamed "${currentFolder}" -> "${expectedFolder}".`);

  invalidateContainers();
  return { ok: true, message: log.join("\n") };
}

export async function cleanOrphanFolder(folderPath: string): Promise<{ ok: boolean; log: string }> {
  const root = deployRoot();
  const rel = path.relative(root, path.resolve(folderPath));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path is outside the deploy root");
  }

  const log: string[] = [];

  const hasCompose = await fs.access(path.join(folderPath, "docker-compose.yml"))
    .then(() => true)
    .catch(() => fs.access(path.join(folderPath, "compose.yml")).then(() => true).catch(() => false));

  if (hasCompose) {
    const compose = await composeCommand();
    const args = [...compose.argsPrefix, "down", "--volumes", "--rmi", "local"];
    log.push(`$ ${compose.cmd} ${args.join(" ")}\n`);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(compose.cmd, args, { cwd: folderPath, shell: false, env: dockerEnv() });
      child.stdout.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ok) return { ok: false, log: log.join("") };
  }

  await fs.rm(folderPath, { recursive: true, force: true });
  log.push(`\nDeleted ${folderPath}\n`);
  return { ok: true, log: log.join("") };
}

export function listProjectEnvFiles(projectId: number): ProjectEnvFile[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE project_id = ? ORDER BY relative_path ASC")
    .all(projectId) as ProjectEnvFileRow[];
  return rows.map(rowToEnvFile);
}

export function createProjectEnvFile(projectId: number, relativePath: string, variables: EnvVariable[]): ProjectEnvFile {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare(
      "INSERT INTO project_env_files (project_id, relative_path, variables_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(projectId, relativePath, JSON.stringify(variables), now, now);
  const row = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE id = ?")
    .get(result.lastInsertRowid) as ProjectEnvFileRow;
  return rowToEnvFile(row);
}

export function updateProjectEnvFile(id: number, projectId: number, relativePath: string, variables: EnvVariable[]): ProjectEnvFile | null {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare("UPDATE project_env_files SET relative_path = ?, variables_json = ?, updated_at = ? WHERE id = ? AND project_id = ?")
    .run(relativePath, JSON.stringify(variables), now, id, projectId);
  if (result.changes === 0) return null;
  const row = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE id = ? AND project_id = ?")
    .get(id, projectId) as ProjectEnvFileRow;
  return rowToEnvFile(row);
}

export function deleteProjectEnvFile(id: number, projectId: number): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM project_env_files WHERE id = ? AND project_id = ?")
    .run(id, projectId);
  return result.changes > 0;
}

const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** Guards against git argument/flag injection — branch names flow into `git` argv as literal args. */
export function isValidBranchName(value: string): boolean {
  return BRANCH_NAME_RE.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/")
    && !value.endsWith(".lock");
}

async function ensureRepo(project: Project, repoPath: string, action: ProjectDeployEvent["action"], branch?: string | null): Promise<RunResult[]> {
  await fs.mkdir(deployRoot(), { recursive: true });
  const gitDir = path.join(repoPath, ".git");
  const hasCheckout = await fs.stat(gitDir).then((stat) => stat.isDirectory()).catch(() => false);

  if (!project.githubRepo) {
    return [{
      ok: false,
      output: "Project has no GitHub repo configured.",
      stdout: "",
      command: "git clone/pull",
    }];
  }

  const authHeader = gitAuthHeader(project);
  if (!hasCheckout) {
    const args = gitArgs(authHeader, ["clone", ...(branch ? ["-b", branch] : []), githubCloneUrl(project.githubRepo), repoPath]);
    const clone = await run(project.id, action, "git", args, {
      timeoutMs: 300_000,
      publicArgs: publicGitArgs(args),
    });
    return [clone];
  }

  // Discard local modifications before pulling — e.g. composeNetworking.ts's
  // stackport-proxy network attachment rewrites the compose file in place on every
  // build/deploy, and deliberately never commits that (ephemeral, StackPort-owned
  // augmentation only). Left uncommitted, that dirty working tree makes the
  // pull/checkout below fail once upstream touches the same file, since neither
  // `--ff-only` nor `checkout -B` will overwrite local changes. This checkout is a
  // deploy target, not a workspace, so there's nothing here worth preserving.
  const reset = await run(project.id, action, "git", ["reset", "--hard", "HEAD"], {
    cwd: repoPath,
    timeoutMs: 60_000,
  });
  if (!reset.ok) return [reset];

  const fetchArgs = gitArgs(authHeader, ["fetch", "--all", "--prune"]);
  const fetch = await run(project.id, action, "git", fetchArgs, {
    cwd: repoPath,
    timeoutMs: 300_000,
    publicArgs: publicGitArgs(fetchArgs),
  });
  if (!fetch.ok) return [fetch];

  // Phase 1.7 — immutable git revision (stackport_yml.md §11): resolve the exact
  // commit this deploy will use once, right after fetch, then check it out directly
  // (detached HEAD) instead of tracking a moving branch. If a later commit lands on
  // the branch while this deploy is still running, it becomes a separate, later
  // deploy candidate — never something this in-progress one silently picks up.
  // Falls back to the project's configured auto-deploy branch when no branch is
  // explicitly given, since after the first SHA-pinned checkout the working tree is
  // permanently in detached-HEAD state — there's no "currently checked out branch"
  // to introspect the way a floating `git pull` used to allow.
  const effectiveBranch = branch ?? project.autoDeployBranch;
  if (!effectiveBranch) {
    return [fetch, {
      ok: false,
      output: "No branch configured to deploy — set an auto-deploy branch or specify one explicitly.",
      stdout: "",
      command: "git checkout",
    }];
  }

  const revParse = await run(project.id, action, "git", ["rev-parse", `origin/${effectiveBranch}`], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  if (!revParse.ok) return [fetch, revParse];
  const sha = revParse.stdout.trim();

  const checkout = await run(project.id, action, "git", ["checkout", sha], {
    cwd: repoPath,
    timeoutMs: 60_000,
  });
  return [fetch, revParse, checkout];
}

/** Dry-run validates a directory's docker-compose file without starting anything —
 *  used to reject a manual upload before it's ever swapped into the live project
 *  directory. */
export async function validateComposeDir(projectId: number, dir: string, composeFile: string | null = null): Promise<{ ok: boolean; output: string }> {
  const result = await runCompose(projectId, "upload", dir, composeFile, ["config", "--quiet"], 60_000);
  return { ok: result.ok, output: result.output };
}

export interface PullSyncResult {
  ok: boolean;
  composeFile: string | null;
  blockedReason: string | null;
}

/** Runs once after every real pull (never on other actions — nothing on disk changes
 *  between pulls): scans and persists the available compose files and resolves/
 *  persists the active one. If the previously active file has vanished from the repo,
 *  this is a hard stop — no silent fallback to a different file — the caller is
 *  responsible for failing the action and alerting on automatic deploys. Routing
 *  (which service/port each domain targets) is configured explicitly per domain —
 *  see projectDomains.ts — not inferred from the compose file. */
async function syncAfterPull(project: Project, repoPath: string): Promise<PullSyncResult> {
  const availableComposeFiles = await scanComposeFiles(repoPath);
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET available_compose_files = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(availableComposeFiles), now, project.id);

  if (project.composeFile && !availableComposeFiles.includes(project.composeFile)) {
    return {
      ok: false,
      composeFile: null,
      blockedReason: `Compose file '${project.composeFile}' no longer exists in the repository (found: ${availableComposeFiles.join(", ") || "none"}).`,
    };
  }

  let composeFile = project.composeFile;
  if (!composeFile) {
    composeFile = resolveDefaultComposeFile(availableComposeFiles);
    if (composeFile) {
      db.prepare("UPDATE projects SET compose_file = ?, updated_at = ? WHERE id = ?").run(composeFile, now, project.id);
    }
  }
  if (!composeFile) {
    return {
      ok: false,
      composeFile: null,
      blockedReason: "No docker-compose.yml/.yaml file found at the repository root.",
    };
  }

  return { ok: true, composeFile, blockedReason: null };
}

/** Reads whatever the resolved compose file currently looks like on disk — for the
 *  read-only "view docker-compose.yml" viewer. Reflects the last stackport-proxy
 *  network augmentation if a deploy action has run since the last pull, or the raw
 *  source file otherwise. */
export async function getProjectComposeFileContent(projectId: number): Promise<{ fileName: string; content: string } | null> {
  const project = getProjectById(projectId);
  if (!project?.composeFile) return null;
  const repoPath = projectRepoDir(project);
  try {
    const content = await fs.readFile(path.join(repoPath, project.composeFile), "utf8");
    return { fileName: project.composeFile, content };
  } catch {
    return null;
  }
}

async function writeEnvFiles(repoPath: string, envFiles: ProjectEnvFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const envFile of envFiles) {
    const normalized = normalizeEnvRelativePath(envFile.relativePath);
    if (!normalized) throw new Error(`Invalid env path: ${envFile.relativePath}`);
    const target = resolveContainedPath(repoPath, normalized);
    if (!target) {
      throw new Error(`Env path escapes repository: ${envFile.relativePath}`);
    }
    const content = envFile.variables.map(({ key, value }) => `${key}=${value}`).join("\n") + "\n";
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    written.push(normalized);
  }
  return written;
}

function actionStartedLabel(action: "build" | "deploy" | "compose" | "recreate"): string {
  if (action === "build") return "Build";
  if (action === "compose") return "Docker compose";
  if (action === "recreate") return "Force recreate";
  return "Deploy";
}

async function currentCommitSha(projectId: number, action: ProjectDeployEvent["action"], repoPath: string): Promise<string | null> {
  const result = await run(projectId, action, "git", ["rev-parse", "HEAD"], { cwd: repoPath, timeoutMs: 15_000 });
  return result.ok ? result.stdout.trim() : null;
}

async function readComposeFileSafe(repoPath: string, composeFile: string | null): Promise<string | null> {
  if (!composeFile) return null;
  return fs.readFile(path.join(repoPath, composeFile), "utf8").catch(() => null);
}

async function runProjectAction(projectId: number, action: "build" | "deploy" | "compose" | "recreate", pullFirst = true, triggeredBy: "manual" | "auto" = "manual"): Promise<DeployResult> {
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }

  const repoPath = projectRepoDir(project);
  const output: string[] = [];
  emit(projectId, action, "status", `${actionStartedLabel(action)} started\n`);

  let composeFile: string | null;
  if (pullFirst) {
    emit(projectId, action, "status", "Stage 1/2: pull from GitHub\n");
    const repoResults = await ensureRepo(project, repoPath, action);
    output.push(...repoResults.map((result) => result.output));

    if (repoResults.some((result) => !result.ok)) {
      emit(projectId, action, "status", `${action} failed\n`, { ok: false, done: true });
      return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
    }

    const sync = await syncAfterPull(project, repoPath);
    if (!sync.ok) {
      const message = `${sync.blockedReason ?? "Deploy blocked."}\n`;
      emit(projectId, action, "stderr", message, { ok: false, done: true });
      output.push(message);
      if (triggeredBy === "auto" && sync.blockedReason) {
        void notifyDeployBlocked(project.name, sync.blockedReason);
      }
      recordFailedDeployment(
        projectId,
        { commitSha: await currentCommitSha(projectId, action, repoPath), branch: project.autoDeployBranch, composeFileName: null, triggeredBy },
        sync.blockedReason ?? "Deploy blocked."
      );
      return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
    }
    composeFile = sync.composeFile;
  } else {
    const hasCheckout = await fs.stat(path.join(repoPath, ".git")).then((stat) => stat.isDirectory()).catch(() => false);
    if (!hasCheckout) {
      const message = "Repository checkout not found. Pull from GitHub before running docker compose.\n";
      emit(projectId, action, "stderr", message, { ok: false, done: true });
      return { ok: false, projectId, repoPath, output: message, action };
    }
    composeFile = requireProjectComposeFile(project);
  }

  if (!composeFile) {
    const message = "No docker-compose.yml/.yaml file found at the repository root.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    output.push(message);
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  // Captured now (before StackPort's own ephemeral network-augmentation rewrite in
  // runCompose) so the recorded "source" is exactly what came from git — the
  // "effective" copy captured after a successful `up` below is what actually ran.
  const sourceCompose = await readComposeFileSafe(repoPath, composeFile);
  const commitSha = await currentCommitSha(projectId, action, repoPath);

  try {
    const written = await writeEnvFiles(repoPath, listProjectEnvFiles(projectId));
    const message = written.length > 0 ? `Wrote env files:\n${written.map((item) => `- ${item}`).join("\n")}\n` : "No env files configured.\n";
    emit(projectId, action, "status", message);
    output.push(message);
  } catch (err) {
    const message = `${err instanceof Error ? err.message : String(err)}\n`;
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    output.push(message);
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  const capacity = await ensureBuildCapacity();
  if (!capacity.ok) {
    emit(projectId, action, "stderr", capacity.message, { ok: false, done: true });
    output.push(capacity.message);
    recordFailedDeployment(projectId, { commitSha, branch: project.autoDeployBranch, composeFileName: composeFile, triggeredBy }, capacity.message.trim());
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }
  if (capacity.message) {
    emit(projectId, action, "status", capacity.message);
    output.push(capacity.message);
  }

  emit(projectId, action, "status", pullFirst ? "Stage 2/2: docker compose\n" : "Docker compose\n");
  const composeArgs = action === "build"
    ? ["build"]
    : action === "recreate"
      ? ["up", "-d", "--build", "--force-recreate"]
      : ["up", "-d", "--build"];
  const compose = await runCompose(projectId, action, repoPath, composeFile, composeArgs, 900_000);
  output.push(compose.output);
  if (composeArgs[0] === "up") {
    if (compose.ok) {
      await snapshotDeployedCompose(repoPath, composeFile);
      const effectiveCompose = await readComposeFileSafe(repoPath, composeFile);
      recordSuccessfulDeployment(projectId, {
        commitSha, branch: project.autoDeployBranch, composeFileName: composeFile, sourceCompose, effectiveCompose, triggeredBy,
      });
    } else {
      recordFailedDeployment(
        projectId,
        { commitSha, branch: project.autoDeployBranch, composeFileName: composeFile, triggeredBy },
        "docker compose up failed — see output for details"
      );
    }
  }
  emit(projectId, action, "status", `${action} ${compose.ok ? "completed" : "failed"}\n`, { ok: compose.ok, done: true });

  return {
    ok: compose.ok,
    projectId,
    repoPath,
    output: output.join("\n\n"),
    action,
  };
}

export function buildProject(projectId: number): Promise<DeployResult> {
  return runProjectAction(projectId, "build");
}

export function deployProject(projectId: number, triggeredBy: "manual" | "auto" = "manual"): Promise<DeployResult> {
  return runProjectAction(projectId, "deploy", true, triggeredBy);
}

export async function pullProject(projectId: number, branch?: string | null, triggeredBy: "manual" | "auto" = "manual"): Promise<DeployResult> {
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action: "pull" };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action: "pull" };
  }

  const repoPath = projectRepoDir(project);
  const output: string[] = [];
  emit(projectId, "pull", "status", branch ? `Pull from GitHub started (branch: ${branch})\n` : "Pull from GitHub started\n");
  const repoResults = await ensureRepo(project, repoPath, "pull", branch);
  output.push(...repoResults.map((result) => result.output));
  const ok = repoResults.every((result) => result.ok);
  if (!ok) {
    emit(projectId, "pull", "status", "pull failed\n", { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action: "pull" };
  }

  const sync = await syncAfterPull(project, repoPath);
  if (!sync.ok) {
    const message = `${sync.blockedReason ?? "Deploy blocked."}\n`;
    output.push(message);
    emit(projectId, "pull", "stderr", message, { ok: false, done: true });
    if (triggeredBy === "auto" && sync.blockedReason) {
      void notifyDeployBlocked(project.name, sync.blockedReason);
    }
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action: "pull" };
  }

  emit(projectId, "pull", "status", "pull completed\n", { ok: true, done: true });
  return {
    ok: true,
    projectId,
    repoPath,
    output: output.join("\n\n"),
    action: "pull",
  };
}

export function composeProject(projectId: number): Promise<DeployResult> {
  return runProjectAction(projectId, "compose", false);
}

/** Same as composeProject, but with `--force-recreate` — for when Compose's config diff misses a change (e.g. an env_file edit) and keeps the stale container running after a rebuild. */
export function recreateProject(projectId: number): Promise<DeployResult> {
  return runProjectAction(projectId, "recreate", false);
}

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Confirms `service` is one of the compose file's own declared `services:` keys —
 *  not just a permissions check, it also protects against a service name that
 *  happens to look like a docker compose flag (e.g. one starting with `-`) being
 *  passed straight into a command's argv. Shared by every single-service action, and
 *  (Phase 1.7) by the domain-route validation in routes/projects.ts. */
export async function serviceExistsInCompose(repoPath: string, composeFile: string, service: string): Promise<boolean> {
  const raw = await fs.readFile(path.join(repoPath, composeFile), "utf8").catch(() => null);
  let doc: unknown = null;
  if (raw != null) {
    try {
      doc = loadYamlDoc(raw);
    } catch {
      doc = null;
    }
  }
  const services = doc && typeof doc === "object" ? (doc as Record<string, unknown>)["services"] : null;
  const knownServices = services && typeof services === "object" ? Object.keys(services as Record<string, unknown>) : [];
  return knownServices.includes(service);
}

/** Rebuilds and restarts a single compose service (`docker compose up -d --build
 *  <service>`) without touching the rest of the stack — for projects with several
 *  containers where redeploying the whole stack to pick up a change in one of them
 *  is unnecessary churn. No pull first, same as composeProject/recreateProject:
 *  nothing on disk changes between pulls, so this only ever acts on the
 *  already-checked-out code. `service` is validated against the compose file's own
 *  `services:` keys before running — not just a permissions check, it also protects
 *  against a service name that happens to look like a docker compose flag (e.g. one
 *  starting with `-`) being passed straight into the command's argv. */
export async function redeployProjectService(projectId: number, service: string): Promise<DeployResult> {
  const action = "redeploy-service" as const;
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }
  if (!SERVICE_NAME_RE.test(service)) {
    return { ok: false, projectId, repoPath: "", output: "Invalid service name", action };
  }

  const repoPath = projectRepoDir(project);
  const hasCheckout = await fs.stat(path.join(repoPath, ".git")).then((stat) => stat.isDirectory()).catch(() => false);
  if (!hasCheckout) {
    const message = "Repository checkout not found. Pull from GitHub before running docker compose.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const composeFile = requireProjectComposeFile(project);
  if (!composeFile) {
    const message = "No docker-compose.yml/.yaml file found at the repository root.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  if (!(await serviceExistsInCompose(repoPath, composeFile, service))) {
    const message = `Service '${service}' not found in ${composeFile}.\n`;
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const output: string[] = [];
  emit(projectId, action, "status", `Redeploy started for service: ${service}\n`);

  try {
    const written = await writeEnvFiles(repoPath, listProjectEnvFiles(projectId));
    const message = written.length > 0 ? `Wrote env files:\n${written.map((item) => `- ${item}`).join("\n")}\n` : "No env files configured.\n";
    emit(projectId, action, "status", message);
    output.push(message);
  } catch (err) {
    const message = `${err instanceof Error ? err.message : String(err)}\n`;
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    output.push(message);
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  const compose = await runCompose(projectId, action, repoPath, composeFile, ["up", "-d", "--build", service], 900_000);
  output.push(compose.output);
  emit(projectId, action, "status", `Redeploy ${compose.ok ? "completed" : "failed"} for service: ${service}\n`, { ok: compose.ok, done: true });

  return { ok: compose.ok, projectId, repoPath, output: output.join("\n\n"), action };
}

/** Parses `docker inspect --format '{{json .Mounts}}'`'s output (one JSON array per
 *  container, newline-separated when multiple container IDs were inspected in one
 *  call) into the set of volume names actually mounted — named and anonymous alike,
 *  since both surface as Type "volume" with a Name docker volume rm can act on
 *  directly. Malformed/empty lines are skipped rather than failing the whole parse. */
function extractVolumeNames(inspectStdout: string): string[] {
  const names = new Set<string>();
  for (const line of inspectStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const mounts = JSON.parse(trimmed) as Array<{ Type?: string; Name?: string }>;
      if (!Array.isArray(mounts)) continue;
      for (const mount of mounts) {
        if (mount.Type === "volume" && mount.Name) names.add(mount.Name);
      }
    } catch {
      // not a JSON line (e.g. a stray docker warning on stderr merged in) — skip it
    }
  }
  return [...names];
}

/**
 * Stops and removes a single compose service's container along with every volume —
 * named or anonymous — currently mounted into it, for clearing persisted data (e.g.
 * resetting a database container) without tearing down the rest of the stack.
 * Destructive and irreversible; the caller is expected to confirm with the user
 * before invoking this. Leaves the service stopped — redeploy it (or run the
 * whole-stack Docker Compose action) afterward to bring it back with fresh volumes.
 *
 * Volumes are read off the container via `docker inspect` BEFORE removal, since
 * `docker volume rm` refuses while any container — even a stopped one — still
 * references it; the container has to go first, but its mounts have to be recorded
 * before that happens. `docker compose rm -v` already clears anonymous volumes as
 * part of removing the container, so by the time the explicit per-volume removal
 * loop runs some of the collected names may already be gone — that's treated as
 * success, not failure.
 */
export async function dropProjectServiceVolumes(projectId: number, service: string): Promise<DeployResult> {
  const action = "drop-volumes" as const;
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }
  if (!SERVICE_NAME_RE.test(service)) {
    return { ok: false, projectId, repoPath: "", output: "Invalid service name", action };
  }

  const repoPath = projectRepoDir(project);
  const hasCheckout = await fs.stat(path.join(repoPath, ".git")).then((stat) => stat.isDirectory()).catch(() => false);
  if (!hasCheckout) {
    const message = "Repository checkout not found. Pull from GitHub before running docker compose.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const composeFile = await resolveDeployedComposeFile(repoPath, project);
  if (!composeFile) {
    const message = "No docker-compose.yml/.yaml file found at the repository root.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  if (!(await serviceExistsInCompose(repoPath, composeFile, service))) {
    const message = `Service '${service}' not found in ${composeFile}.\n`;
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const output: string[] = [];
  emit(projectId, action, "status", `Dropping volumes for service: ${service}\n`);

  const psResult = await runCompose(projectId, action, repoPath, composeFile, ["ps", "-a", "-q", service], 30_000);
  const containerIds = psResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  let volumeNames: string[] = [];
  if (containerIds.length > 0) {
    const inspectResult = await run(projectId, action, "docker", ["inspect", "--format", "{{json .Mounts}}", ...containerIds], {
      cwd: repoPath,
      timeoutMs: 30_000,
      env: dockerEnv(),
    });
    output.push(inspectResult.output);
    volumeNames = extractVolumeNames(inspectResult.stdout);
  }

  const removeResult = await runCompose(projectId, action, repoPath, composeFile, ["rm", "-f", "-s", "-v", service], 120_000);
  output.push(removeResult.output);
  if (!removeResult.ok) {
    emit(projectId, action, "status", `Drop volumes failed for service: ${service}\n`, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  let allVolumesRemoved = true;
  for (const volumeName of volumeNames) {
    const volResult = await run(projectId, action, "docker", ["volume", "rm", volumeName], {
      cwd: repoPath,
      timeoutMs: 30_000,
      env: dockerEnv(),
    });
    output.push(volResult.output);
    const alreadyGone = !volResult.ok && /no such volume/i.test(volResult.output);
    if (!volResult.ok && !alreadyGone) allVolumesRemoved = false;
  }

  invalidateContainers();
  emit(
    projectId,
    action,
    "status",
    `Drop volumes ${allVolumesRemoved ? "completed" : "completed with errors"} for service: ${service}\n`,
    { ok: allVolumesRemoved, done: true }
  );

  return { ok: allVolumesRemoved, projectId, repoPath, output: output.join("\n\n"), action };
}

/**
 * Nuclear option: `docker compose build --no-cache` then `up -d --force-recreate`.
 * Unlike recreateProject, this ignores Docker's build cache entirely — needed when a COPY
 * layer (e.g. an env file baked into the image, or anything Docker's cache thinks is
 * unchanged) is being reused across builds despite the underlying file having changed.
 */
export async function forceRebuildProject(projectId: number): Promise<DeployResult> {
  const action = "force-rebuild" as const;
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }

  const repoPath = projectRepoDir(project);
  const output: string[] = [];
  emit(projectId, action, "status", "Force rebuild started\n");

  const hasCheckout = await fs.stat(path.join(repoPath, ".git")).then((stat) => stat.isDirectory()).catch(() => false);
  if (!hasCheckout) {
    const message = "Repository checkout not found. Pull from GitHub before running docker compose.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const composeFile = requireProjectComposeFile(project);
  if (!composeFile) {
    const message = "No docker-compose.yml/.yaml file found at the repository root.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    output.push(message);
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  try {
    const written = await writeEnvFiles(repoPath, listProjectEnvFiles(projectId));
    const message = written.length > 0 ? `Wrote env files:\n${written.map((item) => `- ${item}`).join("\n")}\n` : "No env files configured.\n";
    emit(projectId, action, "status", message);
    output.push(message);
  } catch (err) {
    const message = `${err instanceof Error ? err.message : String(err)}\n`;
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    output.push(message);
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  const capacity = await ensureBuildCapacity();
  if (!capacity.ok) {
    emit(projectId, action, "stderr", capacity.message, { ok: false, done: true });
    output.push(capacity.message);
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }
  if (capacity.message) {
    emit(projectId, action, "status", capacity.message);
    output.push(capacity.message);
  }

  emit(projectId, action, "status", "Stage 1/2: docker compose build --no-cache (this can take a while)\n");
  const build = await runCompose(projectId, action, repoPath, composeFile, ["build", "--no-cache"], 1_800_000);
  output.push(build.output);
  if (!build.ok) {
    emit(projectId, action, "status", "force-rebuild failed\n", { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  emit(projectId, action, "status", "Stage 2/2: docker compose up -d --force-recreate\n");
  const up = await runCompose(projectId, action, repoPath, composeFile, ["up", "-d", "--force-recreate"], 300_000);
  output.push(up.output);
  if (up.ok) {
    await snapshotDeployedCompose(repoPath, composeFile);
  }
  emit(projectId, action, "status", `force-rebuild ${up.ok ? "completed" : "failed"}\n`, { ok: up.ok, done: true });

  return { ok: up.ok, projectId, repoPath, output: output.join("\n\n"), action };
}

export async function stopProject(projectId: number): Promise<DeployResult> {
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action: "stop" };
  }
  const repoPath = projectRepoDir(project);
  const composeFile = await resolveDeployedComposeFile(repoPath, project);
  emit(projectId, "stop", "status", "Stop started\n");
  const compose = await runCompose(projectId, "stop", repoPath, composeFile, ["down"], 300_000);
  emit(projectId, "stop", "status", `stop ${compose.ok ? "completed" : "failed"}\n`, { ok: compose.ok, done: true });
  return {
    ok: compose.ok,
    projectId,
    repoPath,
    output: compose.output,
    action: "stop",
  };
}

export async function getProjectLogs(
  projectId: number,
  tail: number,
  service?: string,
): Promise<{ ok: boolean; output: string }> {
  const project = getProjectById(projectId);
  if (!project) return { ok: false, output: "Project not found" };

  const repoPath = projectRepoDir(project);
  await fs.mkdir(dockerConfigDir(), { recursive: true });
  const compose = await composeCommand();
  const composeFile = await resolveDeployedComposeFile(repoPath, project);

  const args = [
    ...compose.argsPrefix,
    ...(composeFile ? ["-f", composeFile] : []),
    "logs",
    "--no-color",
    `--tail=${tail}`,
    ...(service ? [service] : []),
  ];

  return new Promise((resolve) => {
    const child = spawn(compose.cmd, args, { cwd: repoPath, shell: false, env: dockerEnv() });
    const chunks: string[] = [];

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, output: chunks.join("") || "Timeout reading logs" });
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    child.on("close", (code) => { clearTimeout(timeout); resolve({ ok: code === 0, output: chunks.join("") }); });
    child.on("error", (err) => { clearTimeout(timeout); resolve({ ok: false, output: err.message }); });
  });
}

/** Phase 1.7 — restores the previous successful deployment's exact source commit and
 *  effective compose file, then redeploys from that restored artifact rather than
 *  re-fetching/re-augmenting from the current repository state. "Restore what was
 *  actually running", not "reconstruct an old state from current configuration"
 *  (stackport_yml.md §17). A deployment with no prior successful revision (e.g. a
 *  project's very first deploy) has nothing to roll back to. */
export async function rollbackProject(projectId: number): Promise<DeployResult> {
  const action = "recreate" as const; // closest existing action kind for the WS event union — a whole-stack up
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }

  const previous = getPreviousSuccessfulDeployment(projectId);
  if (!previous || !previous.commitSha || !previous.composeFileName || previous.effectiveCompose == null) {
    const message = "No previous successful deployment to roll back to.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath: projectRepoDir(project), output: message, action };
  }

  const repoPath = projectRepoDir(project);
  const output: string[] = [];
  emit(projectId, action, "status", `Rolling back to ${previous.commitSha.slice(0, 7)} (${previous.composeFileName})\n`);

  const hasCheckout = await fs.stat(path.join(repoPath, ".git")).then((stat) => stat.isDirectory()).catch(() => false);
  if (!hasCheckout) {
    const message = "Repository checkout not found.\n";
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const reset = await run(projectId, action, "git", ["reset", "--hard", "HEAD"], { cwd: repoPath, timeoutMs: 60_000 });
  output.push(reset.output);
  const checkout = await run(projectId, action, "git", ["checkout", previous.commitSha], { cwd: repoPath, timeoutMs: 60_000 });
  output.push(checkout.output);
  if (!checkout.ok) {
    emit(projectId, action, "stderr", "Rollback failed: could not check out the previous revision.\n", { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  try {
    await fs.writeFile(path.join(repoPath, previous.composeFileName), previous.effectiveCompose, "utf8");
  } catch (err) {
    const message = `Rollback failed: could not restore compose file (${err instanceof Error ? err.message : String(err)}).\n`;
    emit(projectId, action, "stderr", message, { ok: false, done: true });
    return { ok: false, projectId, repoPath, output: output.join("\n\n") + message, action };
  }

  const compose = await runCompose(projectId, action, repoPath, previous.composeFileName, ["up", "-d", "--build"], 900_000);
  output.push(compose.output);
  if (compose.ok) {
    await snapshotDeployedCompose(repoPath, previous.composeFileName);
    recordSuccessfulDeployment(projectId, {
      commitSha: previous.commitSha,
      branch: previous.branch,
      composeFileName: previous.composeFileName,
      sourceCompose: previous.sourceCompose,
      effectiveCompose: previous.effectiveCompose,
      triggeredBy: "manual",
    });
  } else {
    recordFailedDeployment(
      projectId,
      { commitSha: previous.commitSha, branch: previous.branch, composeFileName: previous.composeFileName, triggeredBy: "manual" },
      "rollback: docker compose up failed"
    );
  }
  emit(projectId, action, "status", `rollback ${compose.ok ? "completed" : "failed"}\n`, { ok: compose.ok, done: true });

  return { ok: compose.ok, projectId, repoPath, output: output.join("\n\n"), action };
}

export async function stopAndPurgeProject(projectId: number): Promise<DeployResult> {
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action: "stop-purge" };
  }
  const repoPath = projectRepoDir(project);
  const composeFile = await resolveDeployedComposeFile(repoPath, project);
  emit(projectId, "stop-purge", "status", "Stop and purge volumes started\n");
  const compose = await runCompose(projectId, "stop-purge", repoPath, composeFile, ["down", "-v"], 300_000);
  emit(projectId, "stop-purge", "status", `stop-purge ${compose.ok ? "completed" : "failed"}\n`, { ok: compose.ok, done: true });
  return {
    ok: compose.ok,
    projectId,
    repoPath,
    output: compose.output,
    action: "stop-purge",
  };
}
