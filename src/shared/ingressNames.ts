/** Names for how nginx reaches a project's services.
 *
 *  Every routed service joins the one network nginx is on (`stackport-proxy`, declared by the system
 *  stack) under an alias that carries the project's id, and nginx uses only that alias. Two projects
 *  with a service of the same name (`web`, `api`) therefore never answer for each other.
 *
 *  1.3.0 created one network per project instead (`stackport-ingress-<id>`). That used a slice of
 *  Docker's small default address pool for each project and exhausted it on a server with ~15 projects,
 *  which took every routed project down. Those networks are removed; the name is kept here only to find
 *  and clean them up. */

export const NGINX_CONTAINER = "stackport-nginx";

/** The network nginx and every routed service share. */
export const INGRESS_NETWORK = "stackport-proxy";

/** Networks created by 1.3.0, one per project. */
export const LEGACY_INGRESS_PREFIX = "stackport-ingress-";

export function legacyIngressNetworkName(projectId: number): string {
  return `${LEGACY_INGRESS_PREFIX}${projectId}`;
}

/** The name nginx uses for a routed service. Unique across projects. */
export function ingressAlias(projectId: number, service: string): string {
  return `sp${projectId}-${service}`;
}

/** An isolated project (P7) has a network of its own instead of sharing `stackport-proxy`. nginx and the
 *  project's routed services are on it, and nothing else, so another project's services cannot reach them.
 *  Its subnet comes from a range of Stackport's own, not from Docker's small default pool. */
export const ISOLATED_NETWORK_PREFIX = "stackport-iso-";

export function isolatedNetworkName(projectId: number): string {
  return `${ISOLATED_NETWORK_PREFIX}${projectId}`;
}

/** The alias nginx uses for a routed service of an isolated project. It differs from `sp<id>-<service>` so
 *  that, while a project is being switched, a lookup of it can only be answered on the new network. */
export function isolatedAlias(projectId: number, service: string): string {
  return `iso${projectId}-${service}`;
}

/** The name nginx connects to for a service, which depends on which network the project is on. */
export function upstreamAlias(projectId: number, service: string, isolated: boolean): string {
  return isolated ? isolatedAlias(projectId, service) : ingressAlias(projectId, service);
}

/** Service names that would answer to someone else's alias on the shared network:
 *  Stackport's own admin route (`stackport`) and the aliases above. */
export function isReservedIngressServiceName(service: string): boolean {
  return service.toLowerCase() === "stackport" || /^(sp|iso)\d+-/i.test(service);
}
