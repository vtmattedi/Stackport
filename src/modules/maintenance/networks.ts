import { config } from "../../config/env";
import { getDatabase } from "../../config/database";
import { dockerRun, type DockerRun } from "../ingress/networks";
import { INGRESS_NETWORK, ISOLATED_NETWORK_PREFIX, LEGACY_INGRESS_PREFIX } from "../../shared/ingressNames";
import { GROUP_NETWORK_PREFIX } from "../../shared/networkGroups";
import { expectedComposeProjectName } from "../projects/workspace";
import { SingleFlightCache } from "../../shared/singleFlightCache";
import { computeHeadroom, readAddressPools, slotsTaken, type AddressPool, type NetworkHeadroom } from "./networkHeadroom";

/**
 * The Docker networks on this host, who owns each, and how much of the address pool each takes (Host > Networks).
 * Read only: nothing here changes a network.
 */

export type NetworkOwnerKind =
  | "docker"     // bridge, host, none
  | "stackport"  // the proxy network and Stackport's own stack
  | "project"    // a Compose project Stackport deploys
  | "group"      // a network group (S15)
  | "isolated"   // a project's own ingress network (P7)
  | "legacy"     // a per-project ingress network left by 1.3.0
  | "other";     // anything else on the host (another stack, a hand-made network)

export interface NetworkOwner {
  kind: NetworkOwnerKind;
  /** What to show: the project's name, the group's name, or why it is Stackport's. */
  label: string;
  projectId: number | null;
}

export interface DockerNetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  subnets: string[];
  /** Slices of the daemon's address pools this network takes: 0 when its subnet lies outside them. */
  slices: number;
  containers: { id: string; name: string }[];
  owner: NetworkOwner;
  createdAt: string | null;
  /** Why it may not be removed from the page, or null when it may (nothing attached, and not Stackport's or Docker's own). */
  removalBlocker: string | null;
}

export interface NetworkOverview {
  networks: DockerNetworkInfo[];
  headroom: NetworkHeadroom;
}

export interface RawNetwork {
  Id?: string; Name?: string; Driver?: string; Scope?: string; Internal?: boolean; Created?: string;
  IPAM?: { Config?: { Subnet?: string }[] | null } | null;
  Containers?: Record<string, { Name?: string }> | null;
  Labels?: Record<string, string> | null;
}

const BUILT_IN = new Set(["bridge", "host", "none"]);
/** Stackport's own stack is Compose project `stackport` (docker-compose.system.yml). */
const SYSTEM_COMPOSE_PROJECT = "stackport";

export interface ProjectRef { id: number; name: string }

export function classifyNetwork(raw: RawNetwork, projects: ProjectRef[]): NetworkOwner {
  const name = raw.Name ?? "";
  const labels = raw.Labels ?? {};
  if (BUILT_IN.has(name)) return { kind: "docker", label: "Docker", projectId: null };
  if (name === INGRESS_NETWORK) return { kind: "stackport", label: "shared by nginx and every routed service", projectId: null };
  if (name.startsWith(ISOLATED_NETWORK_PREFIX)) {
    const rest = name.slice(ISOLATED_NETWORK_PREFIX.length);
    const project = projects.find((p) => String(p.id) === rest);
    return { kind: "isolated", label: project ? project.name : `project ${rest} (gone)`, projectId: project?.id ?? null };
  }
  if (name.startsWith(LEGACY_INGRESS_PREFIX)) return { kind: "legacy", label: "left by 1.3.0, safe to remove", projectId: null };
  if (name.startsWith(GROUP_NETWORK_PREFIX)) return { kind: "group", label: name.slice(GROUP_NETWORK_PREFIX.length), projectId: null };
  const compose = labels["com.docker.compose.project"];
  if (compose === SYSTEM_COMPOSE_PROJECT || (compose && compose === config.appServiceName)) return { kind: "stackport", label: "Stackport's own stack", projectId: null };
  if (compose) {
    const project = projects.find((p) => expectedComposeProjectName(p) === compose);
    if (project) return { kind: "project", label: project.name, projectId: project.id };
    return { kind: "other", label: `Compose project ${compose}`, projectId: null };
  }
  return { kind: "other", label: "not made by Stackport", projectId: null };
}

export function describeNetwork(raw: RawNetwork, projects: ProjectRef[], pools: AddressPool[]): DockerNetworkInfo {
  const subnets = (raw.IPAM?.Config ?? []).map((c) => c.Subnet ?? "").filter(Boolean);
  const info: Omit<DockerNetworkInfo, "removalBlocker"> = {
    id: (raw.Id ?? "").slice(0, 12),
    name: raw.Name ?? "",
    driver: raw.Driver ?? "",
    scope: raw.Scope ?? "",
    internal: raw.Internal === true,
    subnets,
    slices: subnets.reduce((sum, subnet) => sum + slotsTaken(subnet, pools), 0),
    containers: Object.entries(raw.Containers ?? {}).map(([id, c]) => ({ id: id.slice(0, 12), name: c.Name ?? id.slice(0, 12) })).sort((a, b) => a.name.localeCompare(b.name)),
    owner: classifyNetwork(raw, projects),
    createdAt: raw.Created ?? null,
  };
  return { ...info, removalBlocker: removalBlocker(info) };
}

function listProjectRefs(): ProjectRef[] {
  return getDatabase().prepare("SELECT id, name FROM projects").all() as ProjectRef[];
}

/** Every network with its owner, and the pool headroom computed from the same read. */
export async function readNetworkOverview(run: DockerRun = dockerRun, projects: ProjectRef[] = listProjectRefs()): Promise<NetworkOverview> {
  const { pools, known } = await readAddressPools(run);
  const ids = (await run(["network", "ls", "--quiet", "--no-trunc"])).split(/\s+/).filter(Boolean);
  const raws: RawNetwork[] = [];
  if (ids.length) {
    const out = await run(["network", "inspect", ...ids, "--format", "{{json .}}"]);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { raws.push(JSON.parse(line) as RawNetwork); } catch { /* a line that is not a network */ }
    }
  }
  const networks = raws.map((raw) => describeNetwork(raw, projects, pools)).sort((a, b) => a.name.localeCompare(b.name));
  return { networks, headroom: computeHeadroom(pools, networks.flatMap((n) => n.subnets), known) };
}

/** Why a network may not be removed from the page, or null when it may. Only networks with nothing attached, and only kinds whose
 *  loss costs nothing that Stackport does not rebuild by itself. */
export function removalBlocker(network: Pick<DockerNetworkInfo, "owner" | "containers">): string | null {
  switch (network.owner.kind) {
    case "docker": return "Docker's own network.";
    case "stackport": return "Part of Stackport.";
    case "group": return "A network group: Stackport removes it itself once nothing uses it.";
    case "isolated": return "A project's isolated network: switch isolation off on the project instead.";
    default: break;
  }
  if (network.containers.length > 0) return `${network.containers.length} ${network.containers.length === 1 ? "container is" : "containers are"} attached.`;
  return null;
}

export interface NetworkRemoval { name: string; removed: boolean; reason: string | null }

export const MAX_REMOVALS = 50;

/**
 * Removes the named networks, each only if it is still removable when this runs: the page may be minutes old, and a container can
 * have joined since. Names are looked up in a fresh read, never passed through unchecked.
 */
export async function removeNetworks(names: string[], run: DockerRun = dockerRun, projects: ProjectRef[] = listProjectRefs()): Promise<NetworkRemoval[]> {
  const wanted = [...new Set(names)].slice(0, MAX_REMOVALS);
  const { networks } = await readNetworkOverview(run, projects);
  const results: NetworkRemoval[] = [];
  for (const name of wanted) {
    const network = networks.find((n) => n.name === name);
    if (!network) { results.push({ name, removed: false, reason: "No such network." }); continue; }
    const blocker = removalBlocker(network);
    if (blocker) { results.push({ name, removed: false, reason: blocker }); continue; }
    // By name, which is unambiguous; a name that could be read as an option is not one Docker would have made.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(network.name)) { results.push({ name, removed: false, reason: "The name is not one Docker would create." }); continue; }
    try {
      await run(["network", "rm", network.name]);
      results.push({ name, removed: true, reason: null });
    } catch (err) {
      results.push({ name, removed: false, reason: err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "Docker refused." });
    }
  }
  overviewCache.invalidate();
  return results;
}

const overviewCache = new SingleFlightCache<NetworkOverview>(() => readNetworkOverview(), 10_000);

/** Cached for 10 seconds: a page that polls should not run `docker network inspect` on every request. */
export function getNetworkOverview(): Promise<NetworkOverview> {
  return overviewCache.get();
}
