import { getContainerListCached } from "./dockerStatusCache";

/** The Docker Compose project name StackPort's own infrastructure runs under (see
 *  docker-compose.system.yml's pinned `name:`). Everything in this compose project —
 *  the app itself today, nginx/certbot once Phase 1.5/1.6 add them as services in the
 *  same file — is the "system plane." Everything else is a managed project (the
 *  "workload plane"). Checking a container's own com.docker.compose.project label
 *  against this constant, rather than maintaining an enumerated container-name list,
 *  means nginx/certbot are automatically covered the moment they're added — no
 *  further changes needed here when those phases land. */
export const SYSTEM_COMPOSE_PROJECT = "stackport";

export function isSystemComposeProject(name: string): boolean {
  return name === SYSTEM_COMPOSE_PROJECT;
}

interface ContainerListEntry {
  ID?: string;
  Names?: string;
  Labels?: string;
}

function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const kv of raw.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

/** Resolves an id-or-name container reference (as passed to `docker exec`/`docker
 *  logs`) against the already-cached `docker ps -a` listing — no new subprocess — and
 *  checks whether it belongs to the system compose project. Matches by exact name or
 *  by id prefix, mirroring how `docker` itself resolves a short id. Fails safe: if the
 *  container can't be found in the current listing at all, it's treated as NOT a
 *  system container (the underlying docker command will simply fail on its own with a
 *  normal "no such container" error) rather than blocking on an unknown target. */
export async function isSystemContainer(containerId: string): Promise<boolean> {
  const res = await getContainerListCached();
  if (!res.ok) return false;

  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: ContainerListEntry;
    try {
      entry = JSON.parse(trimmed) as ContainerListEntry;
    } catch {
      continue;
    }
    const id = String(entry.ID ?? "");
    const names = String(entry.Names ?? "").split(",");
    const matches = id === containerId || id.startsWith(containerId) || names.includes(containerId);
    if (!matches) continue;

    const labels = parseLabels(String(entry.Labels ?? ""));
    return isSystemComposeProject(labels["com.docker.compose.project"] ?? "");
  }

  return false;
}
