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

/** Service names that would answer to someone else's alias on the shared network:
 *  Stackport's own admin route (`stackport`) and the aliases above. */
export function isReservedIngressServiceName(service: string): boolean {
  return service.toLowerCase() === "stackport" || /^sp\d+-/i.test(service);
}
