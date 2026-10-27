import { getDatabase } from "../config/database";
import { rowToProject, type Project, type ProjectRow } from "../entities/Project";
import { actionRegistry, projectRepoKey } from "../services/actionRegistry";
import { getAppVersion } from "../services/appVersion";
import { getContainerListCached } from "../services/dockerStatusCache";
import { listProjectDeployments } from "../services/projectDeployments";
import { listProjectDomains } from "../services/projectDomains";
import { expectedComposeProjectName } from "../services/projectDeploy";

/**
 * What the read-only MCP tools return. Every field is picked by name here, never by
 * spreading a database row or entity, so a column added later can't leak by accident.
 * Never included: anything stored encrypted, credential ids, env files (names or
 * values), nginx extra config, webhook slugs or secrets, build and action logs.
 * tests/mcpReadModel.test.ts checks the exact key sets.
 */

export interface ProjectSummaryView {
  id: number;
  name: string;
  group: string | null;
  sourceType: "github" | "upload";
  repo: string | null;
  branch: string | null;
  deployTrigger: string;
  paused: boolean;
  health: { status: "up" | "down" | "unknown"; lastCheckedAt: string | null; responseMs: number | null };
  lastCommit: { sha: string; message: string | null; author: string | null; at: string | null } | null;
  pendingDeploySha: string | null;
  domains: { hostname: string; ssl: boolean }[];
}

export interface ProjectDetailView extends ProjectSummaryView {
  composeFile: string | null;
  deployments: {
    status: string;
    commitSha: string | null;
    branch: string | null;
    triggeredBy: string;
    createdAt: string;
    blockedReason: string | null;
    unhealthy: boolean;
    rolledBackFrom: boolean;
  }[];
  containers: { service: string | null; state: string; status: string; image: string }[];
  runningAction: { kind: string; startedAt: string } | null;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/name` only. Anything else (a URL, possibly with credentials in it) is
 *  reduced to its path, or dropped. */
export function safeRepo(value: string | null): string | null {
  if (!value) return null;
  if (REPO_RE.test(value)) return value;
  try {
    const path = new URL(value).pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return REPO_RE.test(path) ? path : null;
  } catch {
    return null;
  }
}

function summarize(project: Project): ProjectSummaryView {
  return {
    id: project.id,
    name: project.name,
    group: project.groupName,
    sourceType: project.sourceType,
    repo: safeRepo(project.githubRepo),
    branch: project.autoDeployBranch,
    deployTrigger: project.deployTrigger,
    paused: project.paused,
    health: { status: project.lastStatus, lastCheckedAt: project.lastCheckedAt, responseMs: project.lastResponseMs },
    lastCommit: project.lastCommitSha
      ? { sha: project.lastCommitSha, message: project.lastCommitMessage, author: project.lastCommitAuthor, at: project.lastCommitAt }
      : null,
    pendingDeploySha: project.pendingDeploySha,
    domains: listProjectDomains(project.id).map((d) => ({ hostname: d.domain, ssl: d.useSsl })),
  };
}

function loadProject(id: number): Project | null {
  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function listProjectsView(): ProjectSummaryView[] {
  const rows = getDatabase().prepare("SELECT * FROM projects ORDER BY name").all() as ProjectRow[];
  return rows.map((row) => summarize(rowToProject(row)));
}

interface PsEntry {
  Names?: string;
  State?: string;
  Status?: string;
  Image?: string;
  Labels?: string;
}

function labelValue(labels: string, key: string): string | null {
  for (const kv of labels.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0 && kv.slice(0, eq) === key) return kv.slice(eq + 1);
  }
  return null;
}

async function projectContainers(project: Project): Promise<ProjectDetailView["containers"]> {
  const res = await getContainerListCached();
  if (!res.ok) return [];
  const composeProject = expectedComposeProjectName(project);
  const out: ProjectDetailView["containers"] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    let entry: PsEntry;
    try { entry = JSON.parse(line) as PsEntry; } catch { continue; }
    const labels = String(entry.Labels ?? "");
    if (labelValue(labels, "com.docker.compose.project") !== composeProject) continue;
    out.push({
      service: labelValue(labels, "com.docker.compose.service"),
      state: String(entry.State ?? ""),
      status: String(entry.Status ?? ""),
      image: String(entry.Image ?? ""),
    });
  }
  return out;
}

export async function getProjectView(id: number): Promise<ProjectDetailView | null> {
  const project = loadProject(id);
  if (!project) return null;
  const running = actionRegistry.get(projectRepoKey(id));
  return {
    ...summarize(project),
    composeFile: project.composeFile,
    deployments: listProjectDeployments(id, 10).map((d) => ({
      status: d.status,
      commitSha: d.commitSha,
      branch: d.branch,
      triggeredBy: d.triggeredBy,
      createdAt: d.createdAt,
      blockedReason: d.blockedReason,
      unhealthy: d.healthFailedAt !== null,
      rolledBackFrom: d.rolledBackAt !== null,
    })),
    containers: await projectContainers(project),
    runningAction: running && running.status === "running" ? { kind: running.kind, startedAt: running.startedAt } : null,
  };
}

export interface StatusView {
  version: string;
  commit: string | null;
  projects: { total: number; paused: number; up: number; down: number; unknown: number };
}

export async function getStatusView(): Promise<StatusView> {
  const projects = listProjectsView();
  const version = await getAppVersion();
  const count = (status: string): number => projects.filter((p) => !p.paused && p.health.status === status).length;
  return {
    version: version.version,
    commit: version.commit?.shortSha ?? null,
    projects: {
      total: projects.length,
      paused: projects.filter((p) => p.paused).length,
      up: count("up"),
      down: count("down"),
      unknown: count("unknown"),
    },
  };
}
