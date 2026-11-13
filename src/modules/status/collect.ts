import { getDatabase } from "../../config/database";
import { getContainerListCached, getDockerVersionCached } from "../../integrations/docker/statusCache";
import { actionEstimator } from "../actions/estimate";
import { DEPLOY_KINDS_SQL, actionRegistry } from "../actions/registry";
import { getNginxActiveStatusCached } from "../ingress/nginx/statusCache";
import { getStorageState } from "../maintenance/storage/operations";
import { labelIsTrue, parseLabels, parseNdjson } from "../observability/snapshots/system";
import { expectedComposeProjectName } from "../projects/workspace";
import { rowToProject, type ProjectRow } from "../projects/types";
import { evaluateAlerts } from "./alerts";
import { containerCounts, deriveProjectState, healthOf, type ContainerFacts } from "./projectState";
import { projectTraffic } from "./requestStats";
import type { ActionStatus, Alert, HostStatus, ProjectStatus, StatusSnapshot } from "./types";
import { clean, finite } from "./types";

/**
 * Builds the current StatusSnapshot from the app's own state. Every field is copied by name into the output types, so nothing a table gains
 * later reaches the stream unless it is added here on purpose (see types.ts). The Docker and Nginx reads go through the shared single-flight
 * caches, so a stream with many consumers costs the same as one.
 */

interface SampleRow {
  cpu_percent: number; mem_percent: number; mem_used_mb: number; mem_total_mb: number; load1: number;
  net_rx_bps: number | null; net_tx_bps: number | null; disk_used_pct: number | null; sampled_at: string;
}

function readHost(): HostStatus | null {
  const row = getDatabase().prepare("SELECT * FROM hardware_samples ORDER BY sampled_at DESC LIMIT 1").get() as SampleRow | undefined;
  if (!row) return null;
  return {
    cpuPercent: finite(row.cpu_percent) ?? 0,
    memPercent: finite(row.mem_percent) ?? 0,
    memUsedMb: Math.round(row.mem_used_mb),
    memTotalMb: Math.round(row.mem_total_mb),
    load1: finite(row.load1, 2) ?? 0,
    diskUsedPct: finite(row.disk_used_pct),
    netRxBps: finite(row.net_rx_bps, 0),
    netTxBps: finite(row.net_tx_bps, 0),
    sampledAt: row.sampled_at,
  };
}

interface ContainerRow extends ContainerFacts { name: string; composeProject: string | null }

/**
 * Whether the Nginx container is running, from the result of `docker inspect`. A container that does not exist makes inspect fail, and that
 * is "not running"; an inspect that failed for another reason (a timeout, Docker busy) says nothing, so the answer is unknown (null) and no
 * alert is raised on it.
 */
export function nginxRunningFrom(result: { ok: boolean; stdout: string; stderr: string }): boolean | null {
  if (result.ok) return result.stdout.trim() === "true";
  return /no such (object|container)/i.test(result.stderr) ? false : null;
}

async function readContainers(): Promise<{ available: boolean; containers: ContainerRow[]; nginxRunning: boolean | null }> {
  const version = await getDockerVersionCached();
  if (!version.ok) return { available: false, containers: [], nginxRunning: null };
  const [list, nginx] = await Promise.all([getContainerListCached(), getNginxActiveStatusCached()]);
  const containers = parseNdjson(list.stdout).map((entry): ContainerRow => {
    const labels = parseLabels(String(entry["Labels"] ?? ""));
    return {
      name: String(entry["Names"] ?? ""),
      state: String(entry["State"] ?? ""),
      healthCheckIgnored: labelIsTrue(labels["com.stackport.health.ignore"]),
      composeProject: labels["com.docker.compose.project"] ?? null,
    };
  });
  return { available: true, containers, nginxRunning: nginxRunningFrom(nginx) };
}

/** The containers of one project: the Compose project named after its folder, or (older stacks) containers whose names start with it. */
function containersOf(project: { id: number; name: string }, containers: ContainerRow[]): ContainerRow[] {
  const expected = expectedComposeProjectName(project);
  return containers.filter((container) => container.composeProject === expected || container.name.startsWith(`${expected}-`) || container.name.startsWith(`${expected}_`));
}

/** Each project's latest deploy-kind action, so "its latest deploy failed" is one lookup. */
function latestDeploys(): Map<number, { status: string; startedAt: string }> {
  const rows = getDatabase().prepare(`
    SELECT a.project_id AS project_id, a.status AS status, a.started_at AS started_at
    FROM actions a
    WHERE a.kind IN (${DEPLOY_KINDS_SQL}) AND a.project_id IS NOT NULL
      AND a.started_at = (SELECT MAX(b.started_at) FROM actions b WHERE b.project_id = a.project_id AND b.kind IN (${DEPLOY_KINDS_SQL}))
  `).all() as { project_id: number; status: string; started_at: string }[];
  return new Map(rows.map((row) => [row.project_id, { status: row.status, startedAt: row.started_at }]));
}

export interface CollectedState {
  snapshot: StatusSnapshot;
  /** The alert conditions, before `since` is attached. */
  conditions: Omit<Alert, "since">[];
  /** Each project's group as stored. The snapshot's `group` is cut for the wire, which would make a long group name match nothing. */
  groups: Map<number, string | null>;
}

export async function collectStatus(now: number = Date.now()): Promise<CollectedState> {
  const rows = getDatabase().prepare("SELECT * FROM projects ORDER BY name ASC").all() as ProjectRow[];
  const projectRows = rows.map(rowToProject);
  const [docker, traffic, storage] = await Promise.all([readContainers(), projectTraffic(), getStorageState()]);
  const deploys = latestDeploys();

  const projects: (ProjectStatus & { latestDeployFailedAt: string | null })[] = projectRows.map((project) => {
    const containers = docker.available ? containersOf(project, docker.containers) : null;
    const latest = deploys.get(project.id);
    return {
      id: project.id,
      name: clean(project.name),
      group: project.groupName ? clean(project.groupName) : null,
      state: deriveProjectState(project, containers, docker.available),
      containers: containerCounts(containers),
      health: healthOf(project),
      lastCheckedAt: project.lastCheckedAt,
      traffic: traffic?.get(project.id) ?? null,
      latestDeployFailedAt: latest?.status === "failed" ? latest.startedAt : null,
    };
  });

  const names = new Map(projects.map((project) => [project.id, project.name]));
  const running = actionRegistry.running();
  actionEstimator.prune(new Set(running.map((record) => record.id)));
  const actions: ActionStatus[] = running.map((record) => {
    const estimate = actionEstimator.estimate(record);
    return {
      id: record.id,
      kind: clean(record.kind, 40),
      projectId: record.projectId ?? null,
      projectName: record.projectId !== undefined ? names.get(record.projectId) ?? null : null,
      startedAt: record.startedAt,
      phase: record.phase,
      percent: estimate.percent,
      etaSeconds: estimate.etaSeconds,
      basis: estimate.basis,
    };
  });

  const conditions = evaluateAlerts({
    now,
    projects,
    host: { dockerAvailable: docker.available, nginxRunning: docker.nginxRunning, disk: { state: storage.state, freePct: storage.freePct } },
  });

  return {
    snapshot: {
      host: readHost(),
      // The deploy-failure date was needed for the alerts only; it is not part of a project's status.
      projects: projects.map(({ latestDeployFailedAt: _unused, ...project }) => project),
      actions,
      alerts: [],
    },
    conditions,
    groups: new Map(projectRows.map((project) => [project.id, project.groupName])),
  };
}
