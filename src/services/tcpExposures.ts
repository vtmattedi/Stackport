import { execFile } from "child_process";
import { promisify } from "util";
import { getDatabase } from "../config/database";
import { config } from "../config/env";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const PROXY_IMAGE = "alpine/socat:1.8.0.3";
const CONTAINER_PREFIX = "stackport-tcp-";

interface TcpExposureRow {
  id: number;
  project_id: number;
  public_port: number;
  service: string;
  container_port: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TcpExposure {
  id: number;
  projectId: number;
  publicPort: number;
  service: string;
  containerPort: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class TcpExposureError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "TcpExposureError";
  }
}

function fromRow(row: TcpExposureRow): TcpExposure {
  return {
    id: row.id,
    projectId: row.project_id,
    publicPort: row.public_port,
    service: row.service,
    containerPort: row.container_port,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function containerName(id: number): string {
  return `${CONTAINER_PREFIX}${id}`;
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  try {
    const result = await execFileAsync("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch (err) {
    const detail = err as Error & { stderr?: string; stdout?: string };
    throw new Error((detail.stderr || detail.stdout || detail.message).trim());
  }
}

export function listTcpExposures(projectId: number): TcpExposure[] {
  const rows = getDatabase().prepare(
    "SELECT * FROM tcp_exposures WHERE project_id = ? ORDER BY public_port ASC"
  ).all(projectId) as TcpExposureRow[];
  return rows.map(fromRow);
}

export function listAllTcpExposures(): TcpExposure[] {
  return (getDatabase().prepare("SELECT * FROM tcp_exposures ORDER BY id ASC").all() as TcpExposureRow[]).map(fromRow);
}

export function listTcpServiceNames(projectId: number): string[] {
  const rows = getDatabase().prepare(
    "SELECT DISTINCT service FROM tcp_exposures WHERE project_id = ? ORDER BY service ASC"
  ).all(projectId) as { service: string }[];
  return rows.map((row) => row.service);
}

export function insertTcpExposure(projectId: number, publicPort: number, service: string, containerPort: number): TcpExposure {
  const now = new Date().toISOString();
  try {
    const result = getDatabase().prepare(
      "INSERT INTO tcp_exposures (project_id, public_port, service, container_port, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(projectId, publicPort, service, containerPort, now, now);
    return fromRow(getDatabase().prepare("SELECT * FROM tcp_exposures WHERE id = ?").get(result.lastInsertRowid) as TcpExposureRow);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: tcp_exposures\.public_port/.test(err.message)) {
      throw new TcpExposureError(409, `Public TCP port ${publicPort} is already used by another StackPort exposure.`);
    }
    throw err;
  }
}

function setLastError(id: number, message: string | null): void {
  getDatabase().prepare("UPDATE tcp_exposures SET last_error = ?, updated_at = ? WHERE id = ?")
    .run(message, new Date().toISOString(), id);
}

export async function findPublishedPortConflict(publicPort: number, exceptContainer?: string): Promise<string | null> {
  const reserved = new Map<number, string>([[80, "StackPort HTTP ingress"], [443, "StackPort HTTPS ingress"], [config.port, "StackPort application"]]);
  if (reserved.has(publicPort)) return reserved.get(publicPort)!;

  let ids: string[];
  try {
    ids = (await docker(["ps", "-q"])).trim().split(/\s+/).filter(Boolean);
  } catch (err) {
    throw new TcpExposureError(503, `Docker is unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!ids.length) return null;
  const output = await docker(["inspect", "--format", "{{json .}}", ...ids]);
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let info: { Name?: string; NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> } };
    try { info = JSON.parse(line); } catch { continue; }
    const name = (info.Name ?? "").replace(/^\//, "");
    if (name === exceptContainer) continue;
    for (const bindings of Object.values(info.NetworkSettings?.Ports ?? {})) {
      if (bindings?.some((binding) => Number(binding.HostPort) === publicPort)) return `container ${name || "unknown"}`;
    }
  }
  return null;
}

async function removeProxyContainer(id: number): Promise<void> {
  const name = containerName(id);
  try {
    const raw = await docker(["inspect", "--format", "{{json .Config.Labels}}", name]);
    const labels = JSON.parse(raw) as Record<string, string> | null;
    if (labels?.["com.stackport.managed"] !== "tcp-exposure" || labels?.["com.stackport.tcp-exposure-id"] !== String(id)) {
      throw new TcpExposureError(409, `Container name ${name} is already used by a container StackPort does not own.`);
    }
    await docker(["rm", "-f", name]);
  } catch (err) {
    if (!/No such (object|container)/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

async function proxyIsCurrent(exposure: TcpExposure): Promise<boolean> {
  try {
    const raw = await docker(["inspect", "--format", "{{json .}}", containerName(exposure.id)]);
    const info = JSON.parse(raw) as {
      State?: { Running?: boolean };
      Config?: { Labels?: Record<string, string> };
      HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }> | null> };
    };
    const labels = info.Config?.Labels ?? {};
    const binding = info.HostConfig?.PortBindings?.[`${exposure.publicPort}/tcp`];
    return info.State?.Running === true
      && labels["com.stackport.managed"] === "tcp-exposure"
      && labels["com.stackport.tcp-exposure-id"] === String(exposure.id)
      && labels["com.stackport.project-id"] === String(exposure.projectId)
      && labels["com.stackport.tcp-target"] === `${exposure.service}:${exposure.containerPort}`
      && binding?.some((item) => Number(item.HostPort) === exposure.publicPort) === true;
  } catch (err) {
    if (/No such (object|container)/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

export async function reconcileTcpExposure(exposure: TcpExposure): Promise<void> {
  const name = containerName(exposure.id);
  if (await proxyIsCurrent(exposure)) {
    setLastError(exposure.id, null);
    return;
  }
  const conflict = await findPublishedPortConflict(exposure.publicPort, name);
  if (conflict) {
    const message = `Port ${exposure.publicPort} is already published by ${conflict}.`;
    setLastError(exposure.id, message);
    throw new TcpExposureError(409, message);
  }

  await removeProxyContainer(exposure.id);
  try {
    await docker([
      "run", "-d", "--name", name, "--restart", "unless-stopped",
      "--read-only", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "64m",
      "--network", "stackport-proxy", "-p", `${exposure.publicPort}:${exposure.publicPort}/tcp`,
      "--label", "com.stackport.managed=tcp-exposure",
      "--label", `com.stackport.tcp-exposure-id=${exposure.id}`,
      "--label", `com.stackport.project-id=${exposure.projectId}`,
      "--label", `com.stackport.tcp-target=${exposure.service}:${exposure.containerPort}`,
      PROXY_IMAGE, "-d", "-d",
      `TCP-LISTEN:${exposure.publicPort},fork,reuseaddr`,
      `TCP:${exposure.service}:${exposure.containerPort}`,
    ], 120_000);
    setLastError(exposure.id, null);
  } catch (err) {
    await removeProxyContainer(exposure.id).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    setLastError(exposure.id, message);
    throw new TcpExposureError(/port is already allocated|address already in use/i.test(message) ? 409 : 502, message);
  }
}

export async function deleteTcpExposure(projectId: number, exposureId: number): Promise<boolean> {
  const row = getDatabase().prepare("SELECT * FROM tcp_exposures WHERE id = ? AND project_id = ?")
    .get(exposureId, projectId) as TcpExposureRow | undefined;
  if (!row) return false;
  await removeProxyContainer(exposureId);
  getDatabase().prepare("DELETE FROM tcp_exposures WHERE id = ? AND project_id = ?").run(exposureId, projectId);
  return true;
}

export async function removeProjectTcpRuntime(projectId: number): Promise<void> {
  for (const exposure of listTcpExposures(projectId)) await removeProxyContainer(exposure.id);
}

export async function reconcileAllTcpExposures(): Promise<void> {
  for (const exposure of listAllTcpExposures()) {
    try {
      await reconcileTcpExposure(exposure);
    } catch (err) {
      // One failed bind/target must never stop reconciliation of unrelated routes.
      logger.error({ exposureId: exposure.id, error: err instanceof Error ? err.message : String(err) }, "TCP exposure reconciliation failed");
    }
  }
}
