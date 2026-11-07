import { getNetworkGroup, listNetworkGroupPeers, setNetworkGroup } from "../projects/networkGroups";
import { groupAlias, isServiceName, normalizeNetworkGroup } from "../../shared/networkGroups";
import { applyProjectNetworkGroup, getProjectById, getProjectComposeServiceNames } from "./operations";

/** Changing a project's network group (S15): checking the request, saving it, and applying it to the
 *  running containers. Shared by the admin API and the MCP tools so both enforce the same rules. */

export class NetworkGroupError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "NetworkGroupError";
  }
}

export interface NetworkGroupView {
  group: string | null;
  services: string[];
  availableServices: string[];
  hostnames: { service: string; hostname: string }[];
  peers: { projectId: number; name: string; services: string[]; hostnames: { service: string; hostname: string }[] }[];
}

export async function getNetworkGroupView(projectId: number): Promise<NetworkGroupView> {
  const { group, services } = getNetworkGroup(projectId);
  return {
    group,
    services,
    availableServices: await getProjectComposeServiceNames(projectId),
    hostnames: services.map((service) => ({ service, hostname: groupAlias(projectId, service) })),
    peers: group ? listNetworkGroupPeers(group, projectId).map((peer) => ({
      ...peer, hostnames: peer.services.map((service) => ({ service, hostname: groupAlias(peer.projectId, service) })),
    })) : [],
  };
}

export interface ValidatedAssignment { group: string | null; services: string[] }

/** The request as it will be stored, or why it cannot be. Changes nothing. */
export async function validateNetworkGroupAssignment(projectId: number, rawGroup: unknown, rawServices: unknown): Promise<ValidatedAssignment> {
  if (!getProjectById(projectId)) throw new NetworkGroupError(404, "Project not found");
  const group = normalizeNetworkGroup(rawGroup);
  if (group === undefined) throw new NetworkGroupError(400, "group must be 1-40 characters: lower-case letters, digits, - or _ (or empty to leave the group)");
  const requested: unknown = rawServices ?? [];
  if (!Array.isArray(requested) || requested.length > 50 || !requested.every(isServiceName)) {
    throw new NetworkGroupError(400, "services must be a list of Compose service names");
  }
  const services = group ? [...new Set(requested as string[])].sort() : [];
  const available = await getProjectComposeServiceNames(projectId);
  const unknown = available.length ? services.filter((s) => !available.includes(s)) : [];
  if (unknown.length) throw new NetworkGroupError(400, `Not services of this project's Compose file: ${unknown.join(", ")}`);
  return { group, services };
}

/** Saves the assignment and puts the running containers on (or off) the group's network. `applied` is
 *  false when Docker could not be updated now; the setting is kept and applied on the next deploy. */
export async function assignNetworkGroup(projectId: number, rawGroup: unknown, rawServices: unknown): Promise<{ assignment: ValidatedAssignment; applied: boolean; warning?: string }> {
  const assignment = await validateNetworkGroupAssignment(projectId, rawGroup, rawServices);
  setNetworkGroup(projectId, assignment.group, assignment.services);
  try {
    await applyProjectNetworkGroup(projectId);
    return { assignment, applied: true };
  } catch (err) {
    return { assignment, applied: false, warning: err instanceof Error ? err.message : String(err) };
  }
}
