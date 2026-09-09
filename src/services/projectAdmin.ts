import { getDatabase } from "../config/database";
import { rowToCredential, type Credential, type CredentialRow } from "../entities/Credential";
import { rowToProject, type Project, type ProjectRow } from "../entities/Project";
import { getNginxAppConfig } from "./nginx/configWriter";
import { addProjectDomain } from "./projectDomains";

const GITHUB_REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export class ProjectAdminError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "ProjectAdminError";
  }
}

export interface CreateProjectInput {
  name?: unknown;
  internalPort?: unknown;
  healthCheckEndpoint?: unknown;
  healthCheckIntervalS?: unknown;
  githubRepo?: unknown;
  credentialId?: unknown;
  githubCredentialId?: unknown;
  domain?: unknown;
  autoDeployBranch?: unknown;
  useSsl?: unknown;
  sourceType?: unknown;
}

export interface UpdateProjectInput {
  name?: unknown;
  internalPort?: unknown;
  healthCheckEndpoint?: unknown;
  healthCheckIntervalS?: unknown;
  githubRepo?: unknown;
  credentialId?: unknown;
  githubCredentialId?: unknown;
  autoDeployBranch?: unknown;
  nginxExtraConfig?: unknown;
  nginxExtraBlocks?: unknown;
}

export interface UpdateProjectResult {
  project: Project;
  nginxFieldsChanged: boolean;
}

export function listProjects(): Project[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM projects ORDER BY name ASC")
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function listCredentials(type?: string): Credential[] {
  const rows = type
    ? getDatabase()
      .prepare("SELECT * FROM credentials WHERE type = ? ORDER BY alias ASC")
      .all(type) as CredentialRow[]
    : getDatabase()
      .prepare("SELECT * FROM credentials ORDER BY type ASC, alias ASC")
      .all() as CredentialRow[];
  return rows.map(rowToCredential);
}

export function getProjectOrThrow(projectId: number): Project {
  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (!row) throw new ProjectAdminError(404, "Project not found");
  return rowToProject(row);
}

function parseSourceType(value: unknown): "github" | "upload" {
  return value === "upload" ? "upload" : "github";
}

export function createProject(input: CreateProjectInput): Project {
  const sourceType = parseSourceType(input.sourceType);
  const name = parseProjectName(input.name);
  const internalPort = parseOptionalPortForCreate(input.internalPort);
  const healthCheckEndpoint = parseOptionalHealthEndpointForCreate(input.healthCheckEndpoint);
  const healthCheckIntervalS = parseHealthCheckInterval(input.healthCheckIntervalS, 0);
  const githubRepo = sourceType === "upload" ? parseGithubRepo(input.githubRepo) : parseRequiredGithubRepo(input.githubRepo);
  const credentialId = parseOptionalCredentialId(input.credentialId, "credentialId");
  const githubCredentialId = sourceType === "upload" ? null : parseOptionalCredentialId(input.githubCredentialId, "githubCredentialId");
  const autoDeployBranch = parseOptionalBranch(input.autoDeployBranch, null);

  const db = getDatabase();
  ensureCredentialExists(credentialId);
  ensureGithubCredentialExists(githubCredentialId);
  ensurePortAvailable(internalPort);

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO projects
        (name, internal_port, health_check_endpoint, health_check_interval_s, github_repo,
         credential_id, github_credential_id, auto_deploy_branch, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, internalPort, healthCheckEndpoint, healthCheckIntervalS, githubRepo, credentialId, githubCredentialId, autoDeployBranch, sourceType, now, now);

  const projectId = Number(result.lastInsertRowid);
  // Convenience: the wizard collects one domain at creation time. Additional domains
  // are added afterward via addProjectDomain/the /projects/:id/domains routes.
  if (input.domain !== undefined && input.domain !== null && input.domain !== "") {
    addProjectDomain(projectId, input.domain);
  }
  return getProjectOrThrow(projectId);
}

export function updateProject(projectId: number, input: UpdateProjectInput): UpdateProjectResult {
  const db = getDatabase();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (!existing) throw new ProjectAdminError(404, "Project not found");

  const name = input.name !== undefined ? parseProjectName(input.name) : existing.name;
  const internalPort = input.internalPort !== undefined
    ? parseOptionalPortForUpdate(input.internalPort)
    : existing.internal_port;
  const healthCheckEndpoint = input.healthCheckEndpoint !== undefined
    ? parseOptionalHealthEndpointForUpdate(input.healthCheckEndpoint)
    : existing.health_check_endpoint;
  const healthCheckIntervalS = input.healthCheckIntervalS !== undefined
    ? parseHealthCheckInterval(input.healthCheckIntervalS, existing.health_check_interval_s)
    : existing.health_check_interval_s;
  const githubRepo = input.githubRepo !== undefined
    ? parseOptionalGithubRepoForUpdate(input.githubRepo)
    : existing.github_repo;
  const credentialId = input.credentialId !== undefined
    ? parseNullableCredentialId(input.credentialId, "credentialId")
    : existing.credential_id;
  const githubCredentialId = input.githubCredentialId !== undefined
    ? parseNullableCredentialId(input.githubCredentialId, "githubCredentialId")
    : existing.github_credential_id;
  const autoDeployBranch = input.autoDeployBranch !== undefined
    ? parseOptionalBranch(input.autoDeployBranch, null)
    : existing.auto_deploy_branch ?? null;
  const nginxExtraConfig = input.nginxExtraConfig !== undefined
    ? parseNginxExtraConfig(input.nginxExtraConfig)
    : existing.nginx_extra_config ?? null;
  const nginxExtraBlocks = input.nginxExtraBlocks !== undefined
    ? parseNginxExtraBlocks(input.nginxExtraBlocks)
    : existing.nginx_extra_blocks ?? null;

  ensureCredentialExists(credentialId);
  ensureGithubCredentialExists(githubCredentialId);
  ensurePortAvailable(internalPort, projectId);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE projects
     SET name = ?, internal_port = ?, health_check_endpoint = ?, health_check_interval_s = ?,
         github_repo = ?, credential_id = ?, github_credential_id = ?,
         auto_deploy_branch = ?, nginx_extra_config = ?, nginx_extra_blocks = ?, updated_at = ?
     WHERE id = ?`
  ).run(name, internalPort, healthCheckEndpoint, healthCheckIntervalS, githubRepo, credentialId, githubCredentialId, autoDeployBranch, nginxExtraConfig, nginxExtraBlocks, now, projectId);

  // Routing changes (domain add/remove/ssl-toggle) go through the /projects/:id/domains
  // routes, which trigger their own nginx apply — this only covers fields that live on
  // the projects row itself.
  const routed = internalPort != null;
  return {
    project: getProjectOrThrow(projectId),
    nginxFieldsChanged: existing.internal_port !== internalPort ||
      (routed && (existing.nginx_extra_config ?? null) !== nginxExtraConfig) ||
      (routed && (existing.nginx_extra_blocks ?? null) !== nginxExtraBlocks),
  };
}

export function setProjectPaused(projectId: number, paused: boolean): Project {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (!row) throw new ProjectAdminError(404, "Project not found");

  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET paused = ?, last_status = ?, updated_at = ? WHERE id = ?")
    .run(paused ? 1 : 0, paused ? "unknown" : row.last_status, now, projectId);
  return getProjectOrThrow(projectId);
}

function parseProjectName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectAdminError(400, "name is required");
  }
  return value.trim().slice(0, 100);
}

function parseGithubRepo(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  return GITHUB_REPO_RE.test(normalized) ? normalized : null;
}

function parseRequiredGithubRepo(value: unknown): string {
  const parsed = parseGithubRepo(value);
  if (!parsed) throw new ProjectAdminError(400, "githubRepo is required in 'owner/repo' format");
  return parsed;
}

function parseOptionalGithubRepoForUpdate(value: unknown): string | null {
  const parsed = parseGithubRepo(value);
  if (parsed === null && value !== null && value !== "") {
    throw new ProjectAdminError(400, "githubRepo must be in 'owner/repo' format or empty to clear");
  }
  return parsed;
}

function parseCredentialId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalCredentialId(value: unknown, field: string): number | null {
  const parsed = parseCredentialId(value);
  if (value !== undefined && value !== null && value !== "" && parsed === null) {
    throw new ProjectAdminError(400, `${field} must be a positive integer`);
  }
  return parsed;
}

function parseNullableCredentialId(value: unknown, field: string): number | null {
  const parsed = parseCredentialId(value);
  if (value !== null && value !== "" && parsed === null) {
    throw new ProjectAdminError(400, `${field} must be a positive integer or null to clear`);
  }
  return parsed;
}

function parsePort(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function parseOptionalPortForCreate(value: unknown): number | null {
  const parsed = parsePort(value);
  if (value !== undefined && value !== null && value !== "" && parsed === null) {
    throw new ProjectAdminError(400, "internalPort must be a TCP port from 1 to 65535");
  }
  return parsed;
}

function parseOptionalPortForUpdate(value: unknown): number | null {
  const parsed = parsePort(value);
  if (value !== null && value !== "" && parsed === null) {
    throw new ProjectAdminError(400, "internalPort must be a TCP port from 1 to 65535 or null to clear");
  }
  return parsed;
}

function parseHealthCheckEndpoint(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  try {
    const parsed = new URL(`https://example.test${trimmed}`);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function parseOptionalHealthEndpointForCreate(value: unknown): string | null {
  const parsed = parseHealthCheckEndpoint(value);
  if (value !== undefined && value !== null && value !== "" && parsed === null) {
    throw new ProjectAdminError(400, "healthCheckEndpoint must be a relative path like /health");
  }
  return parsed;
}

const NGINX_EXTRA_CONFIG_MAX_LENGTH = 4000;

function parseNginxExtraConfig(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ProjectAdminError(400, "nginxExtraConfig must be a string");
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return null;
  if (normalized.length > NGINX_EXTRA_CONFIG_MAX_LENGTH) {
    throw new ProjectAdminError(400, `nginxExtraConfig must be ${NGINX_EXTRA_CONFIG_MAX_LENGTH} characters or fewer`);
  }
  return normalized;
}

const NGINX_EXTRA_BLOCKS_MAX_LENGTH = 8000;

function parseNginxExtraBlocks(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ProjectAdminError(400, "nginxExtraBlocks must be a string");
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return null;
  if (normalized.length > NGINX_EXTRA_BLOCKS_MAX_LENGTH) {
    throw new ProjectAdminError(400, `nginxExtraBlocks must be ${NGINX_EXTRA_BLOCKS_MAX_LENGTH} characters or fewer`);
  }
  return normalized;
}

function parseOptionalHealthEndpointForUpdate(value: unknown): string | null {
  const parsed = parseHealthCheckEndpoint(value);
  if (value !== null && value !== "" && parsed === null) {
    throw new ProjectAdminError(400, "healthCheckEndpoint must be a relative path like /health or null to clear");
  }
  return parsed;
}

function parseHealthCheckInterval(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function parseOptionalBranch(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  return typeof value === "string" ? value.trim().slice(0, 255) || null : fallback;
}

function ensureCredentialExists(credentialId: number | null): void {
  if (credentialId === null) return;
  if (!getDatabase().prepare("SELECT id FROM credentials WHERE id = ?").get(credentialId)) {
    throw new ProjectAdminError(400, "Credential not found");
  }
}

function ensureGithubCredentialExists(credentialId: number | null): void {
  if (credentialId === null) return;
  if (!getDatabase().prepare("SELECT id FROM credentials WHERE id = ? AND type = 'github'").get(credentialId)) {
    throw new ProjectAdminError(400, "GitHub credential not found");
  }
}

function ensurePortAvailable(internalPort: number | null, exceptProjectId?: number): void {
  if (internalPort === null) return;
  const db = getDatabase();
  const existing = exceptProjectId === undefined
    ? db.prepare("SELECT id FROM projects WHERE internal_port = ?").get(internalPort)
    : db.prepare("SELECT id FROM projects WHERE internal_port = ? AND id <> ?").get(internalPort, exceptProjectId);
  if (existing) throw new ProjectAdminError(409, "internalPort is already used by another project");

  const appNginx = getNginxAppConfig();
  if (appNginx.enabled && internalPort === appNginx.port) {
    throw new ProjectAdminError(409, `internalPort ${appNginx.port} is reserved for StackPort while app Nginx publishing is enabled`);
  }
}
