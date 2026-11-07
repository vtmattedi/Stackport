/** Names for the per-project ingress networks (S9). nginx joins one network per routed project
 *  and reaches a service by an alias that carries the project's id, so two projects with a
 *  service of the same name (`web`, `api`) can no longer be mixed up by Docker's DNS. */

export const NGINX_CONTAINER = "stackport-nginx";

/** The network that only nginx and this one project's routed services share. */
export function ingressNetworkName(projectId: number): string {
  return `stackport-ingress-${projectId}`;
}

/** The name nginx uses for a routed service. Unique across projects; the service's own name is
 *  still visible inside the project's private network, never to nginx. */
export function ingressAlias(projectId: number, service: string): string {
  return `sp${projectId}-${service}`;
}

/** Service names that would answer to someone else's alias if they joined an ingress network:
 *  Stackport's own admin route (`stackport`) and the aliases above. */
export function isReservedIngressServiceName(service: string): boolean {
  return service.toLowerCase() === "stackport" || /^sp\d+-/i.test(service);
}
