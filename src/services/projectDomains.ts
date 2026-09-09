import { getDatabase } from "../config/database";
import { DOMAIN_RE, getNginxAppConfig } from "./nginx/configWriter";

export interface ProjectDomain {
  id: number;
  projectId: number;
  domain: string;
  useSsl: boolean;
  /** Compose service name this domain routes to — Phase 1.7's domain -> service ->
   *  container_port model (replaces the old single project.internalPort). Empty
   *  string means this row predates the migration and hasn't been reconfigured yet. */
  service: string;
  containerPort: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectDomainRow {
  id: number;
  project_id: number;
  domain: string;
  use_ssl: number;
  service: string;
  container_port: number | null;
  created_at: string;
  updated_at: string;
}

export class ProjectDomainError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "ProjectDomainError";
  }
}

function rowToProjectDomain(row: ProjectDomainRow): ProjectDomain {
  return {
    id: row.id,
    projectId: row.project_id,
    domain: row.domain,
    useSsl: !!row.use_ssl,
    service: row.service,
    containerPort: row.container_port,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjectDomains(projectId: number): ProjectDomain[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_domains WHERE project_id = ? ORDER BY id ASC")
    .all(projectId) as ProjectDomainRow[];
  return rows.map(rowToProjectDomain);
}

/** Bulk-loads every routable project's domains in one query, keyed by project id —
 *  used by configWriter.ts/healthChecker.ts instead of one query per project. */
export function listAllRoutableProjectDomains(): Map<number, ProjectDomain[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_domains ORDER BY id ASC")
    .all() as ProjectDomainRow[];
  const byProject = new Map<number, ProjectDomain[]>();
  for (const row of rows) {
    const domain = rowToProjectDomain(row);
    const list = byProject.get(domain.projectId);
    if (list) list.push(domain);
    else byProject.set(domain.projectId, [domain]);
  }
  return byProject;
}

/** Attaches each project's domains for client-facing responses (the list/get project
 *  routes, and the "projects" WS channel push) — a DTO-assembly step, deliberately not
 *  part of rowToProject/the core Project entity, since most internal callers (the
 *  deploy pipeline's getProjectById, in particular) fetch a project far more often
 *  than they need its domains and shouldn't pay for the extra query. */
export function attachDomains<T extends { id: number }>(projects: T[]): (T & { domains: ProjectDomain[] })[] {
  const byProject = listAllRoutableProjectDomains();
  return projects.map((project) => ({ ...project, domains: byProject.get(project.id) ?? [] }));
}

/** ORDER BY id ASC LIMIT 1 — a monitoring convenience for health checks, not a routing
 *  concern. Every domain gets its own full nginx block set regardless of order. */
export function getFirstProjectDomain(projectId: number): string | null {
  const row = getDatabase()
    .prepare("SELECT domain FROM project_domains WHERE project_id = ? ORDER BY id ASC LIMIT 1")
    .get(projectId) as { domain: string } | undefined;
  return row?.domain ?? null;
}

/** Distinct compose service names this project's domains actually route to — the set
 *  of services that need to join the shared stackport-proxy network so nginx can
 *  reach them by name (composeNetworking.ts). Empty/unconfigured routes (service
 *  still "") are excluded — nothing to attach yet. */
export function listRoutedServiceNames(projectId: number): string[] {
  const rows = getDatabase()
    .prepare("SELECT DISTINCT service FROM project_domains WHERE project_id = ? AND service <> ''")
    .all(projectId) as { service: string }[];
  return rows.map((row) => row.service);
}

export function parseDomainName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed && DOMAIN_RE.test(trimmed) ? trimmed : null;
}

export function ensureDomainAvailable(domain: string, exceptDomainId?: number): void {
  const db = getDatabase();
  const existing = exceptDomainId === undefined
    ? db.prepare("SELECT project_id FROM project_domains WHERE lower(domain) = lower(?)").get(domain)
    : db.prepare("SELECT project_id FROM project_domains WHERE lower(domain) = lower(?) AND id <> ?").get(domain, exceptDomainId);
  if (existing) throw new ProjectDomainError(409, "domain is already used by another project");

  const appNginx = getNginxAppConfig();
  if (appNginx.enabled && appNginx.domain && domain.toLowerCase() === appNginx.domain.toLowerCase()) {
    throw new ProjectDomainError(409, "domain is reserved for StackPort app publishing");
  }
}

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Format-only validation (safe characters, not a shell/argv-injection vector) —
 *  confirming the name is an actual service in the project's compose file is the
 *  caller's job (routes/projects.ts, which already has serviceExistsInCompose from
 *  projectDeploy.ts) so this module doesn't need a cross-import into the deploy
 *  pipeline just for that one check. */
export function parseServiceName(value: unknown): string | null {
  return typeof value === "string" && SERVICE_NAME_RE.test(value) ? value : null;
}

export function parseContainerPort(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export function addProjectDomain(
  projectId: number,
  domainInput: unknown,
  useSsl = false,
  service = "",
  containerPort: number | null = null
): ProjectDomain {
  const domain = parseDomainName(domainInput);
  if (!domain) throw new ProjectDomainError(400, "domain must be a valid hostname (e.g. myapp.example.com)");
  ensureDomainAvailable(domain);

  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    "INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(projectId, domain, useSsl ? 1 : 0, service, containerPort, now, now);
  const row = db.prepare("SELECT * FROM project_domains WHERE id = ?").get(result.lastInsertRowid) as ProjectDomainRow;
  return rowToProjectDomain(row);
}

/** Sets which compose service/container port a domain routes to — Phase 1.7's
 *  routing model. Separate from setProjectDomainSsl (which the SSL-issue flow drives
 *  through its own two-stage apply) since route target and SSL state change
 *  independently. */
export function setProjectDomainRoute(projectId: number, domainId: number, service: string, containerPort: number): ProjectDomain | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE project_domains SET service = ?, container_port = ?, updated_at = ? WHERE id = ? AND project_id = ?"
  ).run(service, containerPort, now, domainId, projectId);
  if (result.changes === 0) return null;
  const row = db.prepare("SELECT * FROM project_domains WHERE id = ? AND project_id = ?").get(domainId, projectId) as ProjectDomainRow;
  return rowToProjectDomain(row);
}

export function removeProjectDomain(projectId: number, domainId: number): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM project_domains WHERE id = ? AND project_id = ?")
    .run(domainId, projectId);
  return result.changes > 0;
}

export function setProjectDomainSsl(projectId: number, domainId: number, useSsl: boolean): ProjectDomain | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE project_domains SET use_ssl = ?, updated_at = ? WHERE id = ? AND project_id = ?"
  ).run(useSsl ? 1 : 0, now, domainId, projectId);
  if (result.changes === 0) return null;
  const row = db.prepare("SELECT * FROM project_domains WHERE id = ? AND project_id = ?").get(domainId, projectId) as ProjectDomainRow;
  return rowToProjectDomain(row);
}

export function getProjectDomain(projectId: number, domainId: number): ProjectDomain | null {
  const row = getDatabase()
    .prepare("SELECT * FROM project_domains WHERE id = ? AND project_id = ?")
    .get(domainId, projectId) as ProjectDomainRow | undefined;
  return row ? rowToProjectDomain(row) : null;
}
