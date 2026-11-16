/* eslint-disable security/detect-non-literal-fs-filename -- paths are inside a project's checkout: its directory plus a Compose file name picked from the files found there; any path a project supplies goes through resolveContainedPath first. */
import { listProjectEnvFiles, normalizeEnvRelativePath, type ProjectEnvFile } from "../projects/envFiles";
export { listProjectEnvFiles, createProjectEnvFile, updateProjectEnvFile, deleteProjectEnvFile, normalizeEnvRelativePath, parseEnvVariables, type EnvVariable, type ProjectEnvFile, type ProjectEnvFileRow } from "../projects/envFiles";
import { deployRoot, projectRepoDir, slugify, expectedComposeProjectName } from "../projects/workspace";
export { deployRoot, projectRepoDir, slugify, expectedComposeProjectName } from "../projects/workspace";
import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { statSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { getDatabase } from "../../config/database";
import { logger } from "../../shared/logger";
import { basicAuthHeader, buildGitEnv, gitCredentialProblem, gitUrlScope } from "../../shared/gitAuth";
import { rowToProject, type Project, type ProjectRow } from "../projects/types";
import { decryptSecret } from "../../shared/crypto";
import { normalizeRelativePath, resolveContainedPath } from "../../shared/safePath";
import { emitProjectDeploy, type ProjectDeployEvent } from "../../application/realtime";
import { actionRegistry, projectRepoKey } from "../actions/registry";
import { loadYamlDoc } from "./compose/yaml";
import { checkComposeFileReferences } from "./compose/references";
import { evaluateResolvedPolicy, formatPolicyRejection, validateComposePolicy, validateResolvedComposePolicy, type ComposeResolution, type PolicyViolation } from "./compose/policy";
import { applyStackportProxyNetwork, connectRunningProxyServices } from "./compose/networking";
import { dockerRun, ensureSharedIngressNetwork } from "../ingress/networks";
import { isIngressIsolated } from "../ingress/isolationState";
import { connectNginx, defaultIsolationDeps, ensureIsolatedNetwork, reconcileIsolatedProject } from "../ingress/isolation";
import { dockerCli, pruneGroupNetworks, syncGroupNetwork } from "./compose/groupNetworks";
import { seedManagedDirectory } from "./compose/seedVolumes";
import { getNetworkGroup, listProjectsInNetworkGroups } from "../projects/networkGroups";
import { buildHardeningOverride, getHardeningDefaults, isHardeningEnabled } from "./compose/hardening";
import { buildVolumesOverride, currentVolumeRoots, planManagedVolumes } from "./compose/managedVolumes";
import { listRoutedServiceNames } from "../ingress/domains";
import { findUnroutedManagedHostname, routeReservedHostname } from "../ingress/managedDomains";
import { beginDeployReport, finishDeployReport } from "../github/reporting";
import { writeNginxConfig } from "../ingress/nginx/configWriter";
import { ensureBuildCapacity } from "../maintenance/storage/operations";
import { getActiveDeployment, markActiveDeploymentUnhealthy, recordFailedDeployment, recordSuccessfulDeployment, resolveRollbackTarget } from "./history";
import { healthCheckUrl, probeHealth, type HealthProbe } from "./health";
import { enqueueNotificationTx, sendNotificationEmail, type DeployRollbackOutcome } from "../notifications/operations";
import { deployBlockedEvent, deployUnhealthyEvent, rollbackFailedEvent, rollbackRecoveredEvent } from "../notifications/events";
import { invalidateContainers } from "../../integrations/docker/statusCache";
import { extractComposeEnvFileRefs, extractComposeIngressTargets, extractRawComposeIngressTargets, type ComposeEnvFileRef, type ComposeIngressTarget } from "./compose/ingress";
import { dotenvKeys, extractComposeVariables, findUnresolvedStackportVariables, type ComposeVariableRef } from "./compose/variables";

//temp fix for honest >15m builds 
const MAX_BUILD_TIME_MS = 60 * 60 * 1000;

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

/** At start-up: running services of every routed project go on the shared ingress network under their
 *  alias (and off a per-project network from 1.3.0), which is how nginx reaches them. This is also how a
 *  project switches over without a redeploy. One project failing does not stop the others, and each failure
 *  is printed where `docker logs` shows it. Resolves to the projects that failed. */
export async function reconcileIngressNetworks(): Promise<number[]> {
  const rows = getDatabase().prepare("SELECT id FROM projects WHERE compose_file IS NOT NULL").all() as { id: number }[];
  const failed: number[] = [];
  for (const { id } of rows) {
    try { await ensureProjectProxyNetwork(id); }
    catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push(id);
      logger.warn({ projectId: id, reason }, "ingress.reconcile.failed");
    }
  }
  logger.info({ checked: rows.length, failed: failed.length }, "ingress.reconcile.done");
  if (failed.length) logger.warn({ projectIds: failed }, `ingress: ${failed.length} of ${rows.length} projects could not be put on the ingress network`);
  return failed;
}

/** Puts the project's running containers on (or takes them off) its network group's network to match
 *  its settings. Called after a deploy, when the settings change and at start-up. */
export async function applyProjectNetworkGroup(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project) return;
  const { group, services } = getNetworkGroup(projectId);
  await syncGroupNetwork({ projectId, composeProject: expectedComposeProjectName(project), group, services });
}

/** Takes a project that is being deleted off its group network. */
export async function leaveNetworkGroup(project: Pick<Project, "id" | "name">): Promise<void> {
  await syncGroupNetwork({ projectId: project.id, composeProject: expectedComposeProjectName(project), group: null, services: [] });
}

export async function reconcileNetworkGroups(): Promise<void> {
  for (const id of listProjectsInNetworkGroups()) {
    try { await applyProjectNetworkGroup(id); }
    catch (err) { logger.warn({ projectId: id, reason: err instanceof Error ? err.message : String(err) }, "network-group.reconcile.failed"); }
  }
  try { await pruneGroupNetworks(dockerCli); }
  catch (err) { logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "network-group.prune.failed"); }
}

/** Services named in the project's Compose file, for choosing which ones join a network group. */
export async function getProjectComposeServiceNames(projectId: number): Promise<string[]> {
  const project = getProjectById(projectId);
  if (!project?.composeFile) return [];
  const doc = await readRawComposeDoc(projectRepoDir(project), project.composeFile);
  const services = doc && typeof doc === "object" ? (doc as Record<string, unknown>)["services"] : null;
  return services && typeof services === "object" ? Object.keys(services as Record<string, unknown>).sort() : [];
}

export async function ensureProjectProxyNetwork(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project?.composeFile) return;
  const services = listRoutedServiceNames(projectId);
  if (!services.length) return;
  if (isIngressIsolated(projectId)) {
    // An isolated project (P7) has a network of its own: make sure it exists, nginx is on it and the services are.
    const isolatedResult = await applyStackportProxyNetwork(projectRepoDir(project), project.composeFile, services, projectId, true);
    if (!isolatedResult.ok) throw new Error(isolatedResult.message);
    const reconciled = await reconcileIsolatedProject(projectId, await defaultIsolationDeps());
    if (!reconciled.ok) throw new Error(reconciled.reason);
    invalidateContainers();
    return;
  }
  await ensureSharedIngressNetwork();
  const result = await applyStackportProxyNetwork(projectRepoDir(project), project.composeFile, services, projectId);
  if (!result.ok) throw new Error(result.message);
  await connectRunningProxyServices(projectId, expectedComposeProjectName(project), services);
  invalidateContainers();
}

async function resolveSelectedComposeFile(projectId: number, selectedFile?: string): Promise<{ repoPath: string; composeFile: string }> {
  const project = getProjectById(projectId);
  if (!project?.composeFile) throw new Error("Pull or upload the project and select a Compose file first");
  const repoPath = projectRepoDir(project);
  const composeFile = selectedFile === undefined ? project.composeFile
    : validateComposeFileChoice(selectedFile, await scanComposeFiles(repoPath));
  if (!composeFile) throw new Error("Select a Compose file found in this project");
  return { repoPath, composeFile };
}

async function readRawComposeDoc(repoPath: string, composeFile: string): Promise<unknown> {
  try { return loadYamlDoc(await fs.readFile(path.join(repoPath, composeFile), "utf8")); }
  catch { return null; }
}

export async function getProjectIngressTargets(projectId: number, selectedFile?: string): Promise<ComposeIngressTarget[]> {
  const { repoPath, composeFile } = await resolveSelectedComposeFile(projectId, selectedFile);
  const compose = await composeCommand();
  // Do not stream or return resolved config: it can contain environment secrets.
  const raw = await new Promise<string | null>((resolve) => {
    execFile(compose.cmd, [...compose.argsPrefix, "-p", expectedComposeProjectName(getProjectById(projectId)!), "-f", composeFile, "config", "--format", "json"],
      { cwd: repoPath, env: dockerEnv(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
  if (raw !== null) return extractComposeIngressTargets(JSON.parse(raw));
  // Env files are only written at deploy time, so a fresh project whose compose file
  // needs one can't be resolved yet. Fall back to the literal ports in the YAML.
  const doc = await readRawComposeDoc(repoPath, composeFile);
  const targets = doc ? extractRawComposeIngressTargets(doc) : [];
  if (!targets.length) throw new Error("Could not resolve Compose config. Check the selected file and required environment variables.");
  return targets;
}

/** The `env_file:` paths a compose file references — lets setup flag the ones not created yet. */
export async function getProjectComposeEnvFiles(projectId: number, selectedFile?: string): Promise<(ComposeEnvFileRef & { existsInSource: boolean })[]> {
  const { repoPath, composeFile } = await resolveSelectedComposeFile(projectId, selectedFile);
  const refs = extractComposeEnvFileRefs(await readRawComposeDoc(repoPath, composeFile));
  return Promise.all(refs.map(async (ref) => {
    const target = resolveContainedPath(repoPath, ref.path);
    // A committed or uploaded file counts; one StackPort wrote on an earlier deploy is a managed env file instead.
    const existsInSource = !!target && await fs.stat(target).then((stat) => stat.isFile()).catch(() => false);
    return { ...ref, existsInSource };
  }));
}

/** The selected Compose file in the checkout, checked against the policy a deploy
 *  enforces, so violations show before anyone deploys. A file that doesn't parse has
 *  none here: the deploy leaves that to docker compose too. */
export interface ProjectComposePolicy {
  composeFile: string;
  /** Problems in the file as written (and the files it points at). Every project is checked for these. */
  violations: PolicyViolation[];
  /** What Compose will actually run, which is where S1's allowlist rules apply (G3). */
  resolved: {
    /** False when the file could not be resolved, so nothing below was checked. */
    checked: boolean;
    /** Why it could not be resolved. */
    reason?: string;
    /** Problems found only after resolving; the ones already in `violations` are left out. */
    violations: PolicyViolation[];
  };
  /** Whether a deploy rejects the resolved problems (true) or only warns about them (false). */
  enforced: boolean;
}

export async function getProjectComposePolicy(projectId: number): Promise<ProjectComposePolicy> {
  const { repoPath, composeFile } = await resolveSelectedComposeFile(projectId);
  const violations = [...validateComposePolicy(await readRawComposeDoc(repoPath, composeFile)).violations, ...await checkComposeFileReferences(repoPath, composeFile)];
  const enforced = isComposePolicyEnforced(projectId);
  const resolution = await resolveComposeConfigDetailed(repoPath, composeFile, expectedComposeProjectName(getProjectById(projectId)!));
  if (!resolution.ok) return { composeFile, violations, resolved: { checked: false, reason: resolution.reason, violations: [] }, enforced };
  const fingerprint = (v: PolicyViolation): string => JSON.stringify([v.section ?? "services", v.service, v.key, v.problem]);
  const known = new Set(violations.map(fingerprint));
  const resolvedOnly = validateResolvedComposePolicy(resolution.doc, { projectDir: repoPath, projectId }).violations.filter((v) => !known.has(fingerprint(v)));
  return { composeFile, violations, resolved: { checked: true, violations: resolvedOnly }, enforced };
}

export interface ComposeVariableStatus extends ComposeVariableRef {
  /** Where Compose would find it: the managed root `.env`, a `.env` in the repository,
   *  or neither (then it falls back to its default, or Stackport's own environment;
   *  see Compose environment isolation / security policy). */
  definedIn: "managed" | "repository" | null;
}

/** The variables the selected Compose file interpolates, and whether the project's
 *  root `.env` defines them. */
export async function getProjectComposeVariables(projectId: number, selectedFile?: string): Promise<ComposeVariableStatus[]> {
  const { repoPath, composeFile } = await resolveSelectedComposeFile(projectId, selectedFile);
  const refs = extractComposeVariables(await readRawComposeDoc(repoPath, composeFile));
  const managed = new Set(
    listProjectEnvFiles(projectId)
      .filter((file) => file.relativePath === ".env")
      .flatMap((file) => file.variables.map((variable) => variable.key)),
  );
  const repoEnvPath = resolveContainedPath(repoPath, ".env");
  // A path resolveContainedPath kept inside the checkout.
   
  const repoText = repoEnvPath ? await fs.readFile(repoEnvPath, "utf8").catch(() => "") : "";
  const repository = dotenvKeys(repoText);
  return refs.map((ref) => ({
    ...ref,
    definedIn: managed.has(ref.name) ? "managed" : repository.has(ref.name) ? "repository" : null,
  }));
}

function dockerConfigDir(): string {
  return path.join(deployRoot(), ".docker");
}

/** What the docker CLI needs to find and reach the daemon and its registries. Nothing else
 *  from Stackport's own environment may reach `docker compose`: Compose interpolates `${VAR}`
 *  from it, so a project's Compose file could read JWT_SECRET and the other secrets (S14).
 *  The proxy and certificate variables stay because pulls and builds fail without them on a
 *  host behind a proxy; note a proxy URL can carry credentials, which a Compose file could
 *  then interpolate. The Windows entries are needed for the CLI to start there. */
const DOCKER_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA",
]);

export function buildDockerEnv(source: NodeJS.ProcessEnv, defaultConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    // Windows env names are case-insensitive ("Path"); keep the original spelling.
    // eslint-disable-next-line security/detect-object-injection -- the keys are environment variable names that pass an allowlist, or names read from the same object.
    if (value !== undefined && DOCKER_ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  env["DOCKER_CONFIG"] ??= defaultConfigDir;
  return env;
}

function dockerEnv(): NodeJS.ProcessEnv {
  return buildDockerEnv(process.env, dockerConfigDir());
}

/** Warns when the Compose file references a variable that only Stackport's environment
 *  used to provide, so a deploy that now gets an empty value is visible in the log. */
async function warnUnresolvedStackportVariables(projectId: number, action: ProjectDeployEvent["action"], composeFile: string): Promise<void> {
  try {
    const refs = await getProjectComposeVariables(projectId, composeFile);
    const passed = buildDockerEnv(process.env, "");
    const missing = findUnresolvedStackportVariables(
      refs,
      new Set(refs.filter((ref) => ref.definedIn !== null).map((ref) => ref.name)),
      process.env,
      // eslint-disable-next-line security/detect-object-injection -- the keys are environment variable names that pass an allowlist, or names read from the same object.
      (name) => passed[name] !== undefined,
    );
    if (missing.length) {
      emit(projectId, action, "stderr",
        `Warning: ${missing.join(", ")} used to come from Stackport's own environment and is no longer passed to docker compose. Define ${missing.length === 1 ? "it" : "them"} in the project's .env.\n`);
    }
  } catch {
    // Advisory only: never block a deploy because the scan failed.
  }
}

function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function gitAuthHeader(project: Project): string | null {
  const credentialId = project.githubCredentialId;
  const row = getDatabase()
    .prepare(credentialId
      ? "SELECT username, secret_enc FROM credentials WHERE id = ? AND type = 'github'"
      : "SELECT username, secret_enc FROM credentials WHERE type = 'github' AND is_default = 1 LIMIT 1")
    .get(...(credentialId ? [credentialId] : [])) as { username: string | null; secret_enc: string } | undefined;
  if (!row?.username) return null;
  return basicAuthHeader(row.username, decryptSecret(row.secret_enc));
}

function emit(projectId: number, action: ProjectDeployEvent["action"], stream: ProjectDeployEvent["stream"], message: string, extra: Partial<ProjectDeployEvent> = {}): void {
  emitProjectDeploy({ projectId, action, stream, message, ...extra });
}

function run(
  projectId: number,
  action: ProjectDeployEvent["action"],
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const publicCommand = [cmd, ...args].join(" ");
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
async function checkComposePolicy(projectId: number, repoPath: string, composeFile: string, resolution: ComposeResolution): Promise<{ ok: boolean; message: string; warning?: string }> {
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
  // The raw checks apply to every project, old or new: a file that reads Stackport's own secrets is not
  // something a project may rely on (the resolved-config rules below warn old projects instead).
  const violations = [...validateComposePolicy(doc).violations, ...await checkComposeFileReferences(repoPath, composeFile)];
  if (violations.length) return { ok: false, message: formatPolicyRejection(violations) };

  // The raw file passed; now check what Compose will actually run (S1). A file that can't be
  // resolved is refused for a project that enforces the policy: it can't be checked.
  return evaluateResolvedPolicy(resolution, { enforced: isComposePolicyEnforced(projectId), projectDir: repoPath, projectId });
}

/** The arguments that resolve a Compose file. `--profile '*'` turns every profile on, so a
 *  service behind `profiles:` is resolved too: naming it in `up` enables its profile, and
 *  it would otherwise run without ever being checked. */
export function composeConfigArgs(argsPrefix: string[], composeFile: string, projectName?: string): string[] {
  return [...argsPrefix, ...(projectName ? ["-p", projectName] : []), "--profile", "*", "-f", composeFile, "config", "--format", "json"];
}

const RESOLVE_TIMEOUT_MS = 60_000;
const RESOLVE_MAX_BUFFER = 32 * 1024 * 1024;

/** The Compose file as `docker compose config` resolves it, or why it could not be. Runs
 *  with the same minimal environment as every other Compose call. The document is never
 *  logged: it can contain secrets. Callers decide what an unresolvable file means. */
export async function resolveComposeConfigDetailed(repoPath: string, composeFile: string, projectName?: string): Promise<ComposeResolution> {
  const compose = await composeCommand();
  const outcome = await new Promise<{ stdout: string } | { reason: string }>((resolve) => {
    execFile(compose.cmd, composeConfigArgs(compose.argsPrefix, composeFile, projectName),
      { cwd: repoPath, env: dockerEnv(), timeout: RESOLVE_TIMEOUT_MS, maxBuffer: RESOLVE_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (!err) { resolve({ stdout }); return; }
        const code = (err as NodeJS.ErrnoException).code;
        const firstLine = String(stderr).split("\n").map((line) => line.trim()).find(Boolean);
        resolve({
          reason: err.killed ? "docker compose config timed out"
            : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "the resolved configuration is too large"
            : (firstLine ?? err.message).slice(0, 300),
        });
      });
  });
  if ("reason" in outcome) return { ok: false, reason: outcome.reason };
  try { return { ok: true, doc: JSON.parse(outcome.stdout) }; } catch { return { ok: false, reason: "docker compose config did not return JSON" }; }
}

/** The resolved document, or null when there is none. For callers that can go on without it. */
export async function resolveComposeConfig(repoPath: string, composeFile: string, projectName?: string): Promise<unknown | null> {
  const resolution = await resolveComposeConfigDetailed(repoPath, composeFile, projectName);
  return resolution.ok ? resolution.doc : null;
}

/** Projects that existed before S2 keep their current mounts until they are migrated. */
export function isVolumesManaged(projectId: number): boolean {
  const row = getDatabase().prepare("SELECT volumes_managed AS managed FROM projects WHERE id = ?").get(projectId) as { managed: number } | undefined;
  return row?.managed !== 0;
}

/** Creates the project's managed mount directories and writes the Compose override that
 *  points its bind mounts at them (S2). Returns the override's path, or null when there
 *  is nothing to override or the file can't be resolved (`up` then reports why). */
async function prepareManagedVolumes(projectId: number, repoPath: string, resolved: unknown): Promise<string | null> {
  const plan = planManagedVolumes(resolved, {
    projectId, projectDir: repoPath, roots: currentVolumeRoots(),
    isFile: (source) => statSync(source, { throwIfNoEntry: false })?.isFile() ?? false,
  });
  const override = buildVolumesOverride(plan);
  if (override === null) return null;
  for (const entry of plan) {
    // A directory that is new starts with the repository's own files in that folder, once; see seedVolumes.ts.
    if (entry.action === "managed" && entry.managedContainerPath) await seedManagedDirectory(entry.source, entry.managedContainerPath);
  }
  const overridePath = path.join(deployRoot(), ".stackport", String(projectId), "volumes.override.yml");
  await fs.mkdir(path.dirname(overridePath), { recursive: true });
  await fs.writeFile(overridePath, override, "utf8");
  return overridePath;
}

/** Writes the hardened-defaults override (S8) and returns its path, or null when the file
 *  can't be resolved (`up` then reports why). */
async function prepareHardening(projectId: number, resolved: unknown): Promise<string | null> {
  const override = buildHardeningOverride(resolved, getHardeningDefaults());
  if (override === null) return null;
  const overridePath = path.join(deployRoot(), ".stackport", String(projectId), "hardening.override.yml");
  await fs.mkdir(path.dirname(overridePath), { recursive: true });
  await fs.writeFile(overridePath, override, "utf8");
  return overridePath;
}

/** New projects reject resolved-config violations; ones that existed before S1 only warn. */
export function isComposePolicyEnforced(projectId: number): boolean {
  const row = getDatabase().prepare("SELECT compose_policy_enforced AS enforced FROM projects WHERE id = ?").get(projectId) as { enforced: number } | undefined;
  return row?.enforced !== 0;
}

/** Subcommands that read what the Compose file points at. `build` is one of them: its build context and
 *  Dockerfile are read from this machine's disk and sent to the Docker daemon, so a context outside the
 *  project would be copied into an image without any container ever starting. */
export function composeSubcommandNeedsPolicy(subcommand: string | undefined): boolean {
  return subcommand === "up" || subcommand === "config" || subcommand === "build";
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
  let resolution: ComposeResolution | null = null;
  if (composeFile) {
    // Phase 1.7 — StackPort-owned augmentation, ephemeral (never committed, same
    // philosophy the old SP:AUTO/port-hiding rewrites used): attaches whichever
    // services this project's domains actually route to onto the project's own
    // shared ingress network, so nginx can reach them by a
    // project-unique alias. Re-applied on every runCompose call because git
    // operations (ensureRepo's reset --hard) wipe
    // it back to the plain source file on every fresh pull, same reason SP:AUTO
    // needed re-substitution before every invocation.
    const routedServices = listRoutedServiceNames(projectId);
    if (routedServices.length > 0) {
      const isolated = isIngressIsolated(projectId);
      try {
        if (isolated) {
          // The network is declared external in the file, so it must exist before `up`, and nginx must be on it.
          await ensureIsolatedNetwork(projectId, dockerRun);
          await connectNginx(projectId, dockerRun);
        } else {
          await ensureSharedIngressNetwork();
        }
      } catch (err) {
        const message = `Could not prepare the ingress network: ${err instanceof Error ? err.message : String(err)}\n`;
        emit(projectId, action, "stderr", message);
        return { ok: false, output: message, stdout: "", command: "ingress network" };
      }
      const network = await applyStackportProxyNetwork(repoPath, composeFile, routedServices, projectId, isolated);
      if (!network.ok) {
        emit(projectId, action, "stderr", network.message);
        return { ok: false, output: network.message, stdout: "", command: "ingress network attachment" };
      }
    }

    if (composeSubcommandNeedsPolicy(args[0])) {
      // Resolved once: the policy, the mount rewrite and the hardening all work from the same snapshot.
      resolution = await resolveComposeConfigDetailed(repoPath, composeFile);
      const policy = await checkComposePolicy(projectId, repoPath, composeFile, resolution);
      if (!policy.ok) {
        emit(projectId, action, "stderr", policy.message);
        return { ok: false, output: policy.message, stdout: "", command: "compose policy check" };
      }
      if (policy.warning) emit(projectId, action, "stderr", policy.warning);
    }
    if (args[0] === "up") await warnUnresolvedStackportVariables(projectId, action, composeFile);
  }
  const compose = await composeCommand();
  const fileArgs = composeFile ? ["-f", composeFile] : [];
  const env = dockerEnv();
  // A build does not run containers, so it needs no mounts or limits, only the policy above.
  if (resolution && args[0] !== "build") {
    const managed = isVolumesManaged(projectId);
    const hardened = isHardeningEnabled(projectId);
    if (!resolution.ok) {
      // Only reachable for a project that doesn't enforce the policy: an enforcing one was refused above.
      if (managed || hardened) {
        emit(projectId, action, "stderr", "Warning — the managed mounts and hardened defaults were not applied because the Compose configuration could not be resolved.\n");
      }
    } else {
      if (managed) {
        try {
          const override = await prepareManagedVolumes(projectId, repoPath, resolution.doc);
          if (override) fileArgs.push("-f", override);
        } catch (err) {
          const message = `${err instanceof Error ? err.message : String(err)}\n`;
          emit(projectId, action, "stderr", message);
          return { ok: false, output: message, stdout: "", command: "managed mount preparation" };
        }
      }
      if (hardened) {
        const override = await prepareHardening(projectId, resolution.doc);
        if (override) fileArgs.push("-f", override);
      }
    }
  }
  if (args[0] === "build" || (args[0] === "up" && args.includes("--build"))) {
    env["DOCKER_BUILDKIT"] = "1";
  }
  // The repository may declare a top-level Compose `name:` shared with another
  // Stackport project. Always use the immutable project-specific namespace instead.
  const project = getProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  const composeProjectName = expectedComposeProjectName(project);
  // Fail closed rather than silently creating a second stack when upgrading an
  // existing deployment whose Compose file used a different explicit name.
  if (composeFile && (args[0] === "up" || args[0] === "down")) {
    const raw = await readRawComposeDoc(repoPath, composeFile);
    const declaredName = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)["name"] : null;
    if (typeof declaredName === "string" && declaredName !== composeProjectName) {
      const legacy = declaredName.trim();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(legacy)) {
        return { ok: false, output: "Compose declares a dynamic or invalid project name; explicit migration is required before deploying.", stdout: "", command: "compose namespace preflight" };
      }
      try {
        for (const resourceArgs of [
          ["ps", "-a", "-q"],
          ["volume", "ls", "-q"],
          ["network", "ls", "-q"],
        ]) {
          const output = await new Promise<string>((resolve, reject) => {
            execFile("docker", [...resourceArgs, "--filter", `label=com.docker.compose.project=${legacy}`],
              { env: dockerEnv(), timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
          });
          if (output.trim()) {
            return { ok: false, output: `Existing Docker resources use legacy Compose project "${legacy}". Migrate them explicitly before deploying "${composeProjectName}" to avoid duplicate stacks or data loss.`, stdout: "", command: "compose namespace preflight" };
          }
        }
      } catch (err) {
        return { ok: false, output: `Could not verify legacy Compose resources: ${err instanceof Error ? err.message : String(err)}`, stdout: "", command: "compose namespace preflight" };
      }
    }
  }
  const result = await run(projectId, action, compose.cmd, [...compose.argsPrefix, "-p", composeProjectName, ...fileArgs, ...args], {
    cwd: repoPath,
    timeoutMs,
    env,
  });
  // Choke point for every docker compose invocation in this file — `up`/`down` are
  // the only subcommands that can change the running container set or which compose
  // stacks exist (unlike `build`/`config`, which don't touch running containers), so
  // only invalidate for those. Runs regardless of ok/fail — a failed up/down can
  // still leave containers partially changed.
  if (args[0] === "up" || args[0] === "down") {
    invalidateContainers();
  }
  if (args[0] === "up" && result.ok) {
    // New containers start without the group network (it is not in the Compose file).
    try { await applyProjectNetworkGroup(projectId); }
    catch (err) { emit(projectId, action, "stderr", `Warning — could not join the network group: ${err instanceof Error ? err.message : String(err)}
`); }
    // A hostname reserved at creation has no route until the Compose file says where it goes.
    try { await routeReservedHostnameAfterUp(projectId); }
    catch (err) { emit(projectId, action, "stderr", `Warning — could not route the reserved hostname: ${err instanceof Error ? err.message : String(err)}
`); }
  }
  return result;
}

/** Routes the hostname reserved for a project (domain manager) once the stack is up and its Compose file declares exactly one
 *  routable port. With several ports it is left for a person: guessing is how traffic reaches the wrong service. */
async function routeReservedHostnameAfterUp(projectId: number): Promise<void> {
  if (!findUnroutedManagedHostname(projectId)) return; // the cheap check first: most projects have nothing to route
  const targets = await getProjectIngressTargets(projectId).catch(() => []);
  const routed = routeReservedHostname(projectId, targets);
  if (!routed) return;
  await ensureProjectProxyNetwork(projectId);
  await writeNginxConfig();
  logger.info({ projectId, hostname: routed.domain, service: routed.service, port: routed.containerPort }, "domains: reserved hostname routed");
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
    // An orphan directory is not proof of ownership of the Compose resources.
    // Running "down --volumes" here could destroy a different project's data
    // when the file declares a shared top-level name.
    return { ok: false, log: "Orphan folder contains a Compose file. Refusing destructive cleanup; verify Docker resource ownership and remove it manually." };
  }

  await fs.rm(folderPath, { recursive: true, force: true });
  log.push(`\nDeleted ${folderPath}\n`);
  return { ok: true, log: log.join("") };
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

export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;

/** With `commitSha`, checks out exactly that commit (it must be on the branch)
 *  instead of the branch tip, so an auto-deploy runs the commit that triggered it
 *  rather than whatever was pushed after it. */
async function ensureRepo(project: Project, repoPath: string, action: ProjectDeployEvent["action"], branch?: string | null, commitSha?: string | null): Promise<RunResult[]> {
  if (commitSha && !COMMIT_SHA_RE.test(commitSha)) {
    return [{ ok: false, output: `Invalid commit SHA "${commitSha}".`, stdout: "", command: "git checkout" }];
  }
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

  // The credential goes to Git in its environment, scoped to github.com, never in its arguments (see shared/gitAuth.ts).
  let authHeader: string | null;
  try {
    authHeader = project.githubAuthMode === "app"
      ? basicAuthHeader("x-access-token", await (await import("../github/binding")).appTokenForProject(project.id))
      : gitAuthHeader(project);
  } catch (err) {
    // An App project never falls back to a token: say what is wrong with the App.
    return [{ ok: false, output: `${err instanceof Error ? err.message : String(err)}
`, stdout: "", command: "github app" }];
  }
  if (authHeader) {
    const problem = await gitCredentialProblem();
    if (problem) return [{ ok: false, output: `${problem}\n`, stdout: "", command: "git" }];
  }
  const gitEnv = buildGitEnv(process.env, authHeader, gitUrlScope(githubCloneUrl(project.githubRepo)));
  if (!hasCheckout) {
    const clone = await run(project.id, action, "git", ["clone", ...(branch ? ["-b", branch] : []), githubCloneUrl(project.githubRepo), repoPath], {
      timeoutMs: 300_000,
      env: gitEnv,
    });
    if (!clone.ok || !commitSha) return [clone];
    const pinnedBranch = branch ?? project.autoDeployBranch;
    if (!pinnedBranch) return [clone, noBranchResult()];
    return [clone, ...await checkoutPinnedCommit(project.id, action, repoPath, commitSha, pinnedBranch)];
  }

  // Discard local modifications before pulling — e.g. composeNetworking.ts's
  // ingress network attachment rewrites the compose file in place on every
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

  const fetch = await run(project.id, action, "git", ["fetch", "--all", "--prune"], {
    cwd: repoPath,
    timeoutMs: 300_000,
    env: gitEnv,
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
  if (!effectiveBranch) return [fetch, noBranchResult()];
  if (commitSha) return [fetch, ...await checkoutPinnedCommit(project.id, action, repoPath, commitSha, effectiveBranch)];

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

function noBranchResult(): RunResult {
  return {
    ok: false,
    output: "No branch configured to deploy — set an auto-deploy branch or specify one explicitly.",
    stdout: "",
    command: "git checkout",
  };
}

/** Checks out `sha` after confirming it is on `origin/<branch>`. A commit that left
 *  the branch (e.g. a force-push) fails the deploy instead of running code that is no
 *  longer on it; the newer tip arrives as its own deploy. */
export async function checkoutPinnedCommit(projectId: number, action: ProjectDeployEvent["action"], repoPath: string, sha: string, branch: string): Promise<RunResult[]> {
  const onBranch = await run(projectId, action, "git", ["merge-base", "--is-ancestor", sha, `origin/${branch}`], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  if (!onBranch.ok) {
    const message = `Commit ${sha.slice(0, 7)} is not on origin/${branch} (was it force-pushed away?). Not deploying it.\n`;
    emit(projectId, action, "stderr", message);
    return [{ ...onBranch, output: `${onBranch.output}\n${message}` }];
  }
  const checkout = await run(projectId, action, "git", ["checkout", sha], { cwd: repoPath, timeoutMs: 60_000 });
  return [onBranch, checkout];
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
 *  read-only "view docker-compose.yml" viewer. Reflects the last
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

export async function writeEnvFiles(repoPath: string, envFiles: ProjectEnvFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const envFile of envFiles) {
    const normalized = normalizeEnvRelativePath(envFile.relativePath);
    if (!normalized) throw new Error(`Invalid env path: ${envFile.relativePath}`);
    // Writing an empty .env for values we cannot read would start the project with blank secrets.
    if (envFile.unreadable) throw new Error(`Cannot write ${envFile.relativePath}: its stored values cannot be decrypted with the configured keys. Restore the key (ENCRYPTION_KEY, or the old one as ENCRYPTION_KEY_PREVIOUS) and deploy again.`);
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

/** A GitHub project needs its clone; an uploaded one only has the files it was given, no `.git`. */
async function hasProjectSource(project: Project, repoPath: string): Promise<boolean> {
  const marker = project.sourceType === "upload" ? repoPath : path.join(repoPath, ".git");
  return fs.stat(marker).then((stat) => stat.isDirectory()).catch(() => false);
}

async function readComposeFileSafe(repoPath: string, composeFile: string | null): Promise<string | null> {
  if (!composeFile) return null;
  return fs.readFile(path.join(repoPath, composeFile), "utf8").catch(() => null);
}

async function runProjectAction(projectId: number, action: "build" | "deploy" | "compose" | "recreate", pullFirst = true, triggeredBy: "manual" | "auto" = "manual", branch?: string | null, pinnedSha?: string | null, options: { build?: boolean } = {}): Promise<DeployResult> {
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }

  const repoPath = projectRepoDir(project);
  const deployedBranch = branch ?? project.autoDeployBranch;
  const output: string[] = [];
  emit(projectId, action, "status", `${actionStartedLabel(action)} started\n`);

  let composeFile: string | null;
  if (pullFirst) {
    emit(projectId, action, "status", "Stage 1/2: pull from GitHub\n");
    const repoResults = await ensureRepo(project, repoPath, action, branch, pinnedSha);
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
      const blockedCommit = await currentCommitSha(projectId, action, repoPath);
      recordBlockedDeployAttempt(project,
        { commitSha: blockedCommit, branch: deployedBranch, composeFileName: null, triggeredBy },
        sync.blockedReason ?? "Deploy blocked.", triggeredBy === "auto" && !!sync.blockedReason);
      return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
    }
    composeFile = sync.composeFile;
  } else {
    const hasCheckout = await hasProjectSource(project, repoPath);
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
  actionRegistry.annotate(projectRepoKey(projectId), { commitSha, branch: deployedBranch });

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
    recordFailedDeployment(projectId, { commitSha, branch: deployedBranch, composeFileName: composeFile, triggeredBy }, capacity.message.trim());
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
      ? ["up", "-d", ...(options.build === false ? ["--no-build"] : ["--build"]), "--force-recreate"]
      : ["up", "-d", "--build"];
  // Module M1: tell GitHub a deploy of this commit has started (never holds the deploy up, never fails it).
  const deployReport = composeArgs[0] === "up" ? await beginDeployReport(project, commitSha) : null;
  const compose = await runCompose(projectId, action, repoPath, composeFile, composeArgs, MAX_BUILD_TIME_MS );
  output.push(compose.output);
  let healthy = true;
  if (composeArgs[0] === "up") {
    if (compose.ok) {
      await snapshotDeployedCompose(repoPath, composeFile);
      const effectiveCompose = await readComposeFileSafe(repoPath, composeFile);
      recordSuccessfulDeployment(projectId, {
        commitSha, branch: deployedBranch, composeFileName: composeFile, sourceCompose, effectiveCompose, triggeredBy,
      });
      const health = await gateOnHealth(project, action, commitSha, true);
      output.push(health.output);
      healthy = health.ok;
    } else {
      recordFailedDeployment(
        projectId,
        { commitSha, branch: deployedBranch, composeFileName: composeFile, triggeredBy },
        "docker compose up failed — see output for details"
      );
    }
  }
  const ok = compose.ok && healthy;
  await finishDeployReport(deployReport, { ok, healthy });
  emit(projectId, action, "status", `${action} ${ok ? "completed" : "failed"}\n`, { ok, done: true });

  return {
    ok,
    projectId,
    repoPath,
    output: output.join("\n\n"),
    action,
  };
}

export function buildProject(projectId: number): Promise<DeployResult> {
  return runProjectAction(projectId, "build");
}

/** Pull (optionally switching to `branch`, else the auto-deploy branch) then `docker compose up -d --build`.
 *  `commitSha` deploys that commit instead of the branch tip (see ensureRepo). */
export function deployProject(projectId: number, triggeredBy: "manual" | "auto" = "manual", branch?: string | null, commitSha?: string | null): Promise<DeployResult> {
  return runProjectAction(projectId, "deploy", true, triggeredBy, branch, commitSha);
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
    const blockedCommit = await currentCommitSha(projectId, "pull", repoPath);
    recordBlockedDeployAttempt(project,
      { commitSha: blockedCommit, branch: branch ?? project.autoDeployBranch, composeFileName: null, triggeredBy },
      sync.blockedReason ?? "Deploy blocked.", triggeredBy === "auto" && !!sync.blockedReason);
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

/** Why the running revision cannot be restarted as it is, or null when it can. A restart recreates the containers
 *  from the checkout, so it only restarts what is running while the checkout is still at the deployed commit:
 *  after a pull that was not deployed it would start the newer code instead. */
export async function restartBlocker(projectId: number): Promise<string | null> {
  const project = getProjectById(projectId);
  if (!project) return "Project not found.";
  const active = getActiveDeployment(projectId);
  if (!active?.commitSha || project.sourceType === "upload") return null; // nothing recorded to compare with
  const head = await currentCommitSha(projectId, "recreate", projectRepoDir(project));
  if (head === null) return "Could not read the checkout's commit, so it cannot be compared with the running revision. Not restarted.";
  if (head === active.commitSha) return null;
  return `The checkout is at ${head.slice(0, 7)} but the running revision is ${active.commitSha.slice(0, 7)}: a restart would start the checkout, not what is running. Deploy the new revision, or roll back to the running one.`;
}

/** Recreates the project's containers from the images already built for the running revision: no pull and no
 *  build (`--no-build`), and refused when the checkout has moved on (restartBlocker). */
export async function restartProject(projectId: number): Promise<DeployResult> {
  const blocker = await restartBlocker(projectId);
  if (blocker) return { ok: false, projectId, repoPath: "", output: `${blocker}\n`, action: "recreate" };
  return runProjectAction(projectId, "recreate", false, "manual", undefined, undefined, { build: false });
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
  const hasCheckout = await hasProjectSource(project, repoPath);
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
  const hasCheckout = await hasProjectSource(project, repoPath);
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

  const hasCheckout = await hasProjectSource(project, repoPath);
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
    "-p", expectedComposeProjectName(project),
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

const HEALTH_POLL_INTERVAL_MS = 3_000;

export interface HealthGateDeps {
  probe: (url: string) => Promise<HealthProbe>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realHealthGateDeps: HealthGateDeps = {
  probe: probeHealth,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Polls the project's health check until it passes or the project's grace period
 *  (deploy_health_grace_s) runs out. Null when the project has no health check, in
 *  which case the deploy is not verified, as before. */
export async function verifyDeployHealth(
  projectId: number,
  action: ProjectDeployEvent["action"],
  deps: HealthGateDeps = realHealthGateDeps,
): Promise<{ healthy: boolean; url: string } | null> {
  const project = getProjectById(projectId);
  const url = project ? healthCheckUrl({
    id: project.id,
    paused: project.paused ? 1 : 0,
    health_check_endpoint: project.healthCheckEndpoint,
    health_check_domain_id: project.healthCheckDomainId,
  }) : null;
  if (!project || !url) return null;

  const graceMs = project.deployHealthGraceS * 1000;
  emit(projectId, action, "status", `Checking health: GET ${url} (up to ${project.deployHealthGraceS}s)\n`);
  const startedAt = deps.now();
  for (;;) {
    const probe = await deps.probe(url);
    if (probe.status === "up") {
      emit(projectId, action, "status", `Health check passed${probe.responseMs !== null ? ` (${probe.responseMs} ms)` : ""}\n`);
      return { healthy: true, url };
    }
    if (deps.now() - startedAt + HEALTH_POLL_INTERVAL_MS > graceMs) break;
    await deps.sleep(HEALTH_POLL_INTERVAL_MS);
  }
  emit(projectId, action, "stderr", `Health check did not pass within ${project.deployHealthGraceS}s.\n`);
  return { healthy: false, url };
}

/** Persist the blocked attempt and its alert together; email stays best effort. */
export function recordBlockedDeployAttempt(project: Project, input: Parameters<typeof recordFailedDeployment>[1], reason: string, notify: boolean): number {
  const db = getDatabase();
  let email: ReturnType<typeof deployBlockedEvent> | undefined;
  const attemptId = db.transaction(() => {
    const id = recordFailedDeployment(project.id, input, reason);
    if (notify) {
      email = deployBlockedEvent(project.name, reason, project.id, id);
      enqueueNotificationTx(db, email);
    }
    return id;
  })();
  if (email) void sendNotificationEmail(email);
  return attemptId;
}

/** Commit the unhealthy classification before attempting optional recovery. */
export async function gateOnHealth(
  project: Project,
  action: ProjectDeployEvent["action"],
  commitSha: string | null,
  allowAutoRollback: boolean,
  healthDeps?: HealthGateDeps,
  rollbackFailureOperationId?: string,
  restore: typeof rollbackProject = rollbackProject,
): Promise<{ ok: boolean; output: string }> {
  const result = await verifyDeployHealth(project.id, action, healthDeps);
  if (!result) return { ok: true, output: "" };
  if (result.healthy) return { ok: true, output: `Health check passed: ${result.url}\n` };

  const operationId = actionRegistry.get(projectRepoKey(project.id))?.id ?? randomUUID();
  let deploymentId: string | number = operationId;
  const db = getDatabase();
  db.transaction(() => {
    deploymentId = markActiveDeploymentUnhealthy(project.id) ?? operationId;
    enqueueNotificationTx(db, deployUnhealthyEvent(project.name, commitSha, result.url, "none", project.id, deploymentId));
    if (rollbackFailureOperationId) enqueueNotificationTx(db, rollbackFailedEvent(project.name, project.id, rollbackFailureOperationId));
  })();
  const lines = [`Deployed, but the health check did not pass: ${result.url}\n`];
  let rollback: DeployRollbackOutcome = "none";
  if (allowAutoRollback && project.autoRollbackUnhealthy) {
    emit(project.id, action, "status", "Rolling back automatically (project setting)\n");
    try {
      const restored = await restore(project.id, undefined, { nested: true, operationId });
      lines.push(restored.output);
      rollback = restored.ok ? "done" : "failed";
    } catch {
      rollback = "failed";
      lines.push("Automatic rollback could not complete. Check the action log.");
    }
  }
  void sendNotificationEmail(deployUnhealthyEvent(project.name, commitSha, result.url, rollback, project.id, deploymentId));
  if (rollback === "failed") db.transaction(() => enqueueNotificationTx(db, rollbackFailedEvent(project.name, project.id, operationId)))();
  if (rollback === "done") db.transaction(() => enqueueNotificationTx(db, rollbackRecoveredEvent(project.name, project.id, operationId)))();
  return { ok: false, output: lines.join("\n") };
}

/** Phase 1.7 — restores a successful deployment's exact source commit and effective
 *  compose file, then redeploys from that restored artifact rather than
 *  re-fetching/re-augmenting from the current repository state. "Restore what was
 *  actually running", not "reconstruct an old state from current configuration"
 *  (stackport_yml.md §17). Restores `deploymentId`, or by default the revision
 *  resolveRollbackTarget picks; the revision it replaces is marked rolled back from. */
export async function rollbackProject(projectId: number, deploymentId?: number, opts: { nested?: boolean; operationId?: string } = {}): Promise<DeployResult> {
  // Nested inside another action (an automatic rollback after a failed health check):
  // that action sends the single final "done" event, so the client doesn't end early.
  const done = (ok: boolean): Partial<ProjectDeployEvent> => (opts.nested ? {} : { ok, done: true });
  const action = "recreate" as const; // closest existing action kind for the WS event union — a whole-stack up
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, projectId, repoPath: "", output: "Project not found", action };
  }
  if (project.paused) {
    return { ok: false, projectId, repoPath: "", output: "Project is paused", action };
  }

  const resolved = resolveRollbackTarget(projectId, deploymentId);
  if (!resolved.ok) {
    const message = `${resolved.error}\n`;
    emit(projectId, action, "stderr", message, done(false));
    return { ok: false, projectId, repoPath: projectRepoDir(project), output: message, action };
  }
  const previous = resolved.target;
  // resolveRollbackTarget only returns revisions with all three recorded.
  if (!previous.commitSha || !previous.composeFileName || previous.effectiveCompose == null) {
    throw new Error("Rollback target is missing its commit or compose file");
  }

  const repoPath = projectRepoDir(project);
  const output: string[] = [];
  emit(projectId, action, "status", `Rolling back to ${previous.commitSha.slice(0, 7)} (${previous.composeFileName})\n`);

  const hasCheckout = await fs.stat(path.join(repoPath, ".git")).then((stat) => stat.isDirectory()).catch(() => false);
  if (!hasCheckout) {
    const message = "Repository checkout not found.\n";
    emit(projectId, action, "stderr", message, done(false));
    return { ok: false, projectId, repoPath, output: message, action };
  }

  const reset = await run(projectId, action, "git", ["reset", "--hard", "HEAD"], { cwd: repoPath, timeoutMs: 60_000 });
  output.push(reset.output);
  const checkout = await run(projectId, action, "git", ["checkout", previous.commitSha], { cwd: repoPath, timeoutMs: 60_000 });
  output.push(checkout.output);
  if (!checkout.ok) {
    emit(projectId, action, "stderr", "Rollback failed: could not check out the previous revision.\n", done(false));
    return { ok: false, projectId, repoPath, output: output.join("\n\n"), action };
  }

  try {
    await fs.writeFile(path.join(repoPath, previous.composeFileName), previous.effectiveCompose, "utf8");
  } catch (err) {
    const message = `Rollback failed: could not restore compose file (${err instanceof Error ? err.message : String(err)}).\n`;
    emit(projectId, action, "stderr", message, done(false));
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
    }, { rollback: true });
  } else {
    const db = getDatabase();
    db.transaction(() => {
      const attempt = recordFailedDeployment(projectId,
        { commitSha: previous.commitSha, branch: previous.branch, composeFileName: previous.composeFileName, triggeredBy: "manual" },
        "rollback: docker compose up failed");
      if (opts.nested) enqueueNotificationTx(db, rollbackFailedEvent(project.name, project.id, opts.operationId ?? String(attempt)));
    })();
  }
  let ok = compose.ok;
  if (compose.ok) {
    const health = await gateOnHealth(project, action, previous.commitSha, false, undefined, opts.nested ? opts.operationId : undefined);
    output.push(health.output);
    ok = health.ok;
  }
  emit(projectId, action, "status", `rollback ${ok ? "completed" : "failed"}\n`, done(ok));

  return { ok, projectId, repoPath, output: output.join("\n\n"), action };
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
