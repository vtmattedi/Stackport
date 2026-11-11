import { config } from "../../config/env";
import { nthSubnet } from "../../shared/cidr";
import { INGRESS_NETWORK, ingressAlias, isolatedAlias, isolatedNetworkName, NGINX_CONTAINER } from "../../shared/ingressNames";
import { logger } from "../../shared/logger";
import { dockerRun, type DockerRun } from "./networks";
import { probeRoute } from "./health";

/**
 * A network of its own for a project's routed services (P7).
 *
 * 1.3.0 tried this with a network per project from Docker's default address pool, and the pool (about 31
 * networks for the whole host) ran out, which took routed projects down. This version differs in three ways:
 *
 *  - the subnet is chosen here, from a range of Stackport's own (`STACKPORT_ISOLATION_RANGE`, one /27 per
 *    project), so Docker's pool is never used;
 *  - it is opt-in per project, and reversible;
 *  - nothing is switched until the new route has been seen working from inside nginx. The old route
 *    (`sp<id>-<service>` on `stackport-proxy`) stays in place and in nginx's config until then, so a failure
 *    at any step leaves the project exactly as it was.
 */

/** One /27 per project: 30 addresses for nginx and the routed services. */
const PROJECT_PREFIX = 27;

export class IsolationError extends Error {}

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const notThere = (err: unknown): boolean => /No such (network|container|object)|is not connected|not found/i.test(text(err));
const alreadyThere = (err: unknown): boolean => /already exists|already connected/i.test(text(err));

/** The project's subnet inside the range, or null when the range cannot hold that many projects. */
export function isolatedSubnet(projectId: number, range: string = config.isolationRange): string | null {
  return nthSubnet(range, PROJECT_PREFIX, projectId);
}

export interface IsolationRoute { service: string; port: number }

export interface IsolationDeps {
  docker: DockerRun;
  /** Reachability of an alias from inside nginx (P2's probe). */
  probe: (alias: string, port: number) => Promise<{ failure: string | null; detail: string }>;
  /** The project's routed services and the ports nginx connects to. */
  routes: (projectId: number) => IsolationRoute[];
  composeProject: (projectId: number) => string;
  setFlag: (projectId: number, isolated: boolean) => void;
  /** Rewrites and applies nginx's config from the current state, so upstreams follow the flag. */
  applyNginx: () => Promise<{ ok: boolean; message: string }>;
  /** Rewrites the project's Compose attachments to match the flag, so a later deploy keeps them. */
  applyCompose: (projectId: number, isolated: boolean) => Promise<{ ok: boolean; message: string }>;
  /** Recreates the project's TCP proxies on the network the project is now reached on. */
  applyTcp: () => Promise<void>;
  range: string;
}

export interface IsolationResult {
  ok: boolean;
  /** What was done, in order, for the admin to read. */
  steps: string[];
  /** Why it stopped, when it did. */
  reason?: string;
}

async function containersOf(docker: DockerRun, composeProject: string, service: string): Promise<string[]> {
  const out = await docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${composeProject}`, "--filter", `label=com.docker.compose.service=${service}`]);
  return out.trim().split(/\s+/).filter(Boolean);
}

async function attachment(docker: DockerRun, id: string, network: string): Promise<{ Aliases?: string[] | null } | undefined> {
  const networks = JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", id])) as Record<string, { Aliases?: string[] | null }>;
  // eslint-disable-next-line security/detect-object-injection -- the key is one of our own network names, and the lookup only reads.
  return networks[network];
}

/** Creates the project's network if it is not there. The subnet is explicit so Docker's pool is not drawn on. */
export async function ensureIsolatedNetwork(projectId: number, docker: DockerRun, range: string = config.isolationRange): Promise<"created" | "present"> {
  const name = isolatedNetworkName(projectId);
  try {
    await docker(["network", "inspect", name, "--format", "{{.Id}}"]);
    return "present";
  } catch (err) {
    if (!notThere(err)) throw err;
  }
  const subnet = isolatedSubnet(projectId, range);
  if (!subnet) throw new IsolationError(`The isolation range ${range} has no room for project ${projectId}. Set STACKPORT_ISOLATION_RANGE to a larger range.`);
  try {
    await docker(["network", "create", "--driver", "bridge", "--subnet", subnet, "--label", `com.stackport.isolated-project=${projectId}`, name]);
  } catch (err) {
    if (alreadyThere(err)) return "present";
    throw new IsolationError(`Docker could not create ${name} (${subnet}): ${text(err)}. If this range overlaps another network on the host, set STACKPORT_ISOLATION_RANGE to a free one.`);
  }
  return "created";
}

export async function connectNginx(projectId: number, docker: DockerRun): Promise<void> {
  try { await docker(["network", "connect", isolatedNetworkName(projectId), NGINX_CONTAINER]); }
  catch (err) { if (!alreadyThere(err)) throw new IsolationError(`nginx could not join ${isolatedNetworkName(projectId)}: ${text(err)}`); }
}

/** Puts each running container of the routed services on the isolated network under its alias. */
export async function connectIsolatedServices(projectId: number, composeProject: string, services: string[], docker: DockerRun): Promise<number> {
  const network = isolatedNetworkName(projectId);
  let placed = 0;
  for (const service of services) {
    const alias = isolatedAlias(projectId, service);
    for (const id of await containersOf(docker, composeProject, service)) {
      const current = await attachment(docker, id, network);
      if (!current?.Aliases?.includes(alias)) {
        // Docker cannot add an alias to a connected endpoint, so a connected one is reconnected.
        if (current) { try { await docker(["network", "disconnect", network, id]); } catch (err) { if (!notThere(err)) throw err; } }
        await docker(["network", "connect", "--alias", alias, network, id]);
      }
      placed += 1;
    }
  }
  return placed;
}

/** Puts each running container back on the shared ingress network under the alias nginx uses there. */
async function connectSharedServices(projectId: number, composeProject: string, services: string[], docker: DockerRun): Promise<number> {
  let placed = 0;
  for (const service of services) {
    const alias = ingressAlias(projectId, service);
    for (const id of await containersOf(docker, composeProject, service)) {
      const current = await attachment(docker, id, INGRESS_NETWORK);
      if (!current?.Aliases?.includes(alias)) {
        if (current) { try { await docker(["network", "disconnect", INGRESS_NETWORK, id]); } catch (err) { if (!notThere(err)) throw err; } }
        await docker(["network", "connect", "--alias", alias, "--alias", service, INGRESS_NETWORK, id]);
      }
      placed += 1;
    }
  }
  return placed;
}

async function disconnectFrom(network: string, composeProject: string, services: string[], docker: DockerRun): Promise<void> {
  for (const service of services) {
    for (const id of await containersOf(docker, composeProject, service)) {
      try { await docker(["network", "disconnect", network, id]); } catch (err) { if (!notThere(err)) throw err; }
    }
  }
}

/** Takes the isolated network away again: services and nginx off it, then the network removed. Best effort. */
async function removeIsolatedNetwork(projectId: number, composeProject: string, services: string[], docker: DockerRun): Promise<void> {
  const network = isolatedNetworkName(projectId);
  await disconnectFrom(network, composeProject, services, docker).catch(() => undefined);
  try { await docker(["network", "disconnect", "--force", network, NGINX_CONTAINER]); } catch { /* not connected */ }
  try { await docker(["network", "rm", network]); } catch { /* still in use or already gone */ }
}

const distinctServices = (routes: IsolationRoute[]): string[] => [...new Set(routes.map((r) => r.service))];

async function verifyAll(routes: IsolationRoute[], aliasOf: (service: string) => string, probe: IsolationDeps["probe"]): Promise<string | null> {
  for (const route of routes) {
    const outcome = await probe(aliasOf(route.service), route.port);
    if (outcome.failure) return `${route.service}:${route.port} did not answer from nginx (${outcome.failure}${outcome.detail ? `: ${outcome.detail}` : ""})`;
  }
  return null;
}

/** Moves a project's routes onto its own network. Every step before nginx's config changes is undone by
 *  removing what was added; every step after it is undone by restoring the flag and the config. */
export async function switchToIsolated(projectId: number, deps: IsolationDeps): Promise<IsolationResult> {
  const steps: string[] = [];
  const routes = deps.routes(projectId);
  const services = distinctServices(routes);
  const project = deps.composeProject(projectId);
  if (!routes.length) return { ok: false, steps, reason: "This project has no routed domain, so there is nothing to isolate." };
  const fail = async (reason: string, undo: () => Promise<void>): Promise<IsolationResult> => {
    await undo().catch((err: unknown) => logger.warn({ err, projectId }, "isolation: undo after a failed switch also failed"));
    steps.push("Undone: the project is as it was.");
    return { ok: false, steps, reason };
  };
  const removeNew = (): Promise<void> => removeIsolatedNetwork(projectId, project, services, deps.docker);

  try {
    steps.push(`Network ${isolatedNetworkName(projectId)}: ${await ensureIsolatedNetwork(projectId, deps.docker, deps.range)} (${isolatedSubnet(projectId, deps.range)}).`);
    await connectNginx(projectId, deps.docker);
    steps.push("nginx joined it.");
    const placed = await connectIsolatedServices(projectId, project, services, deps.docker);
    steps.push(`${placed} running container${placed === 1 ? "" : "s"} joined it.`);
    if (placed === 0) return await fail("None of the project's routed services is running, so the new route cannot be checked. Start the project and try again.", removeNew);
  } catch (err) {
    return fail(text(err), removeNew);
  }

  const unreachable = await verifyAll(routes, (s) => isolatedAlias(projectId, s), deps.probe);
  if (unreachable) return fail(`The new route was not working, so nothing was changed: ${unreachable}.`, removeNew);
  steps.push("Every route answers from nginx on the new network. The old route is still in place.");

  // From here nginx's config changes, so a failure restores it.
  const revert = async (): Promise<void> => {
    deps.setFlag(projectId, false);
    await deps.applyNginx();
    await removeNew();
  };
  deps.setFlag(projectId, true);
  const nginx = await deps.applyNginx();
  if (!nginx.ok) return fail(`nginx refused the new configuration: ${nginx.message.trim() || "no message"}. The old configuration was restored.`, revert);
  steps.push("nginx now uses the new route.");
  try { await deps.applyTcp(); steps.push("TCP proxies follow the project onto its network."); }
  catch (err) { steps.push(`TCP proxies could not be moved (${text(err)}); the next start-up retries it.`); }

  const stillUnreachable = await verifyAll(routes, (s) => isolatedAlias(projectId, s), deps.probe);
  if (stillUnreachable) return fail(`After nginx switched, ${stillUnreachable}. The old configuration was restored.`, revert);

  const compose = await deps.applyCompose(projectId, true);
  if (!compose.ok) return fail(`The Compose file could not be updated for the next deploy: ${compose.message.trim()}. The old configuration was restored.`, revert);

  try {
    await disconnectFrom(INGRESS_NETWORK, project, services, deps.docker);
    steps.push(`Services left ${INGRESS_NETWORK}, so other projects can no longer reach them.`);
  } catch (err) {
    // Isolation is in place and working; only the shared attachment lingers. Say so rather than undo a working route.
    steps.push(`Services are on the new network, but leaving ${INGRESS_NETWORK} failed (${text(err)}); the next start-up retries it.`);
  }
  return { ok: true, steps };
}

/** Moves a project's routes back onto the shared network, the mirror of switchToIsolated. */
export async function switchToShared(projectId: number, deps: IsolationDeps): Promise<IsolationResult> {
  const steps: string[] = [];
  const routes = deps.routes(projectId);
  const services = distinctServices(routes);
  const project = deps.composeProject(projectId);

  try {
    const placed = await connectSharedServices(projectId, project, services, deps.docker);
    steps.push(`${placed} running container${placed === 1 ? "" : "s"} are on ${INGRESS_NETWORK} again.`);
  } catch (err) {
    return { ok: false, steps, reason: `Could not put the services back on ${INGRESS_NETWORK}: ${text(err)}. Nothing was changed.` };
  }
  const unreachable = await verifyAll(routes, (s) => ingressAlias(projectId, s), deps.probe);
  if (unreachable) return { ok: false, steps, reason: `The shared route was not working, so nothing was changed: ${unreachable}.` };

  deps.setFlag(projectId, false);
  const nginx = await deps.applyNginx();
  if (!nginx.ok) {
    deps.setFlag(projectId, true);
    await deps.applyNginx().catch(() => undefined);
    return { ok: false, steps, reason: `nginx refused the configuration: ${nginx.message.trim() || "no message"}. The isolated configuration was restored.` };
  }
  steps.push("nginx now uses the shared route.");
  try { await deps.applyTcp(); steps.push("TCP proxies follow the project back to the shared network."); }
  catch (err) { steps.push(`TCP proxies could not be moved (${text(err)}); the next start-up retries it.`); }
  const compose = await deps.applyCompose(projectId, false);
  if (!compose.ok) steps.push(`The Compose file could not be updated for the next deploy (${compose.message.trim()}); the next deploy repairs it.`);
  await removeIsolatedNetwork(projectId, project, services, deps.docker);
  steps.push(`${isolatedNetworkName(projectId)} removed.`);
  return { ok: true, steps };
}

/** For a project that is being deleted: nginx off its network and the network removed, if nothing is still on it. */
export async function removeIsolatedNetworkQuietly(projectId: number, docker: DockerRun = dockerRun): Promise<void> {
  const network = isolatedNetworkName(projectId);
  try { await docker(["network", "disconnect", "--force", network, NGINX_CONTAINER]); } catch { /* not connected, or no such network */ }
  try { await docker(["network", "rm", network]); } catch { /* absent, or its containers still run: they keep the network until stopped */ }
}

/** At start-up, and after anything that recreates nginx: an isolated project's network exists, nginx is on it and
 *  its services are on it and off the shared network. Reports a reason instead of throwing, one project at a time. */
export async function reconcileIsolatedProject(projectId: number, deps: Pick<IsolationDeps, "docker" | "routes" | "composeProject" | "range">): Promise<{ ok: boolean; reason?: string }> {
  try {
    const services = distinctServices(deps.routes(projectId));
    const project = deps.composeProject(projectId);
    await ensureIsolatedNetwork(projectId, deps.docker, deps.range);
    await connectNginx(projectId, deps.docker);
    await connectIsolatedServices(projectId, project, services, deps.docker);
    await disconnectFrom(INGRESS_NETWORK, project, services, deps.docker);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: text(err) };
  }
}

/** The real dependencies, wired lazily so the modules that need isolation state do not import nginx or Compose code. */
export async function defaultIsolationDeps(): Promise<IsolationDeps> {
  const [{ listProjectDomains }, { writeNginxConfig }, { setIngressIsolated }, { applyStackportProxyNetwork }, { getProjectById }, workspace, { reconcileAllTcpExposures }] = await Promise.all([
    import("./domains"), import("./nginx/configWriter"), import("./isolationState"),
    import("../deployments/compose/networking"), import("../deployments/operations"), import("../projects/workspace"), import("./tcp"),
  ]);
  return {
    docker: dockerRun,
    probe: (alias, port) => probeRoute(alias, port),
    routes: (projectId) => listProjectDomains(projectId).filter((d) => d.service && d.containerPort).map((d) => ({ service: d.service, port: d.containerPort as number })),
    composeProject: (projectId) => {
      const project = getProjectById(projectId);
      return project ? workspace.expectedComposeProjectName(project) : "";
    },
    setFlag: (projectId, isolated) => { setIngressIsolated(projectId, isolated); },
    applyNginx: async () => { const result = await writeNginxConfig(); return { ok: result.ok, message: result.output ?? "" }; },
    applyCompose: async (projectId, isolated) => {
      const project = getProjectById(projectId);
      if (!project?.composeFile) return { ok: true, message: "" };
      const services = [...new Set(listProjectDomains(projectId).filter((d) => d.service).map((d) => d.service))];
      return applyStackportProxyNetwork(workspace.projectRepoDir(project), project.composeFile, services, projectId, isolated);
    },
    applyTcp: () => reconcileAllTcpExposures(),
    range: config.isolationRange,
  };
}
