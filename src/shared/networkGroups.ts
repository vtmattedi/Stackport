/** Names for network groups: projects that share a group reach each other's chosen services
 *  over one Docker network, by a hostname that carries the project's id so equal service names
 *  in two projects never collide. */

const GROUP_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** A group name as it is stored: trimmed and lower case, or null when it is empty or not usable. */
export function normalizeNetworkGroup(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  if (!name) return null;
  return GROUP_NAME.test(name) ? name : undefined;
}

export function isServiceName(value: unknown): value is string {
  return typeof value === "string" && SERVICE_NAME.test(value);
}

export const GROUP_NETWORK_PREFIX = "stackport-group-";

export function groupNetworkName(group: string): string {
  return `${GROUP_NETWORK_PREFIX}${group}`;
}

/** The hostname other projects in the group use for a service, e.g. `db.p7`. */
export function groupAlias(projectId: number, service: string): string {
  return `${service}.p${projectId}`;
}
