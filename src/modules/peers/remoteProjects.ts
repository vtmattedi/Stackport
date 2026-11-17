import { getDatabase } from "../../config/database";
import { listProjectDeploys, type DeployHistoryEntry } from "../deployments/deployList";
import { getProjectLogs } from "../deployments/operations";
import { listAllRoutableProjectDomains, listProjectDomains, type ProjectDomain } from "../ingress/domains";
import { rowToProject, type Project, type ProjectRow } from "../projects/types";
import { collectStatus } from "../status/collect";
import type { ProjectStatus } from "../status/types";

/**
 * What this instance tells a controller about its projects (the managed side of `sp-control/v1`). Built field by field, never a row or a
 * Project passed through: credential ids, installation ids and webhook details are not the controller's business, and a column added later
 * must not reach another instance by accident.
 */

export interface RemoteProject {
  id: number;
  name: string;
  group: string | null;
  sourceType: "github" | "upload";
  githubRepo: string | null;
  branch: string | null;
  paused: boolean;
  favorite: boolean;
  /** The same status the live stream reports: state, container counts, health and traffic. */
  status: ProjectStatus | null;
  domains: ProjectDomain[];
  lastCommit: { sha: string; message: string | null; author: string | null; at: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteProjectDetail extends RemoteProject {
  composeFile: string | null;
  availableComposeFiles: string[];
  deployTrigger: string;
  healthCheck: { endpoint: string | null; intervalS: number; graceS: number };
  hardenedDefaults: boolean;
  composePolicyEnforced: boolean;
  volumesManaged: boolean;
  ingressIsolated: boolean;
  networkGroup: string | null;
}

/** Collecting the status reads Docker, the proxy's access log and storage for every project. Several controllers (or several open pages) within a few seconds share one read. */
const STATUS_TTL_MS = 5_000;
let statusMemo: { at: number; value: Promise<Map<number, ProjectStatus>> } | null = null;

function projectStatuses(): Promise<Map<number, ProjectStatus>> {
  const now = Date.now();
  if (statusMemo && now - statusMemo.at < STATUS_TTL_MS) return statusMemo.value;
  const value = collectStatus().then(({ snapshot }) => new Map(snapshot.projects.map((status) => [status.id, status])));
  statusMemo = { at: now, value };
  // A failed read must not be served again for the rest of the window.
  value.catch(() => { if (statusMemo?.value === value) statusMemo = null; });
  return value;
}

function summarize(project: Project, statuses: Map<number, ProjectStatus>, domains: ProjectDomain[]): RemoteProject {
  return {
    id: project.id,
    name: project.name,
    group: project.groupName,
    sourceType: project.sourceType,
    githubRepo: project.githubRepo,
    branch: project.autoDeployBranch,
    paused: project.paused,
    favorite: project.favorite,
    status: statuses.get(project.id) ?? null,
    domains,
    lastCommit: project.lastCommitSha ? { sha: project.lastCommitSha, message: project.lastCommitMessage, author: project.lastCommitAuthor, at: project.lastCommitAt } : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function listRemoteProjects(): Promise<RemoteProject[]> {
  const rows = getDatabase().prepare("SELECT * FROM projects ORDER BY favorite DESC, name ASC").all() as ProjectRow[];
  const statuses = await projectStatuses();
  const domains = listAllRoutableProjectDomains();
  return rows.map((row) => { const project = rowToProject(row); return summarize(project, statuses, domains.get(project.id) ?? []); });
}

export async function getRemoteProject(id: number): Promise<RemoteProjectDetail | null> {
  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) return null;
  const project = rowToProject(row);
  return {
    ...summarize(project, await projectStatuses(), listProjectDomains(id)),
    composeFile: project.composeFile,
    availableComposeFiles: project.availableComposeFiles,
    deployTrigger: project.deployTrigger,
    healthCheck: { endpoint: project.healthCheckEndpoint, intervalS: project.healthCheckIntervalS, graceS: project.deployHealthGraceS },
    hardenedDefaults: project.hardenedDefaults,
    composePolicyEnforced: project.composePolicyEnforced,
    volumesManaged: project.volumesManaged,
    ingressIsolated: project.ingressIsolated,
    networkGroup: project.networkGroup,
  };
}

export function remoteDeploys(id: number): DeployHistoryEntry[] | null {
  return listProjectDeploys(id);
}

/** `tail` and `service` come from parseLogQuery, which has already bounded the one and checked the other. */
export async function remoteLogs(id: number, tail: number, service?: string): Promise<{ ok: boolean; output: string } | null> {
  const exists = getDatabase().prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!exists) return null;
  return getProjectLogs(id, tail, service);
}
