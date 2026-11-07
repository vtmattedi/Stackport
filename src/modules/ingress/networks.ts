import { execFile } from "child_process";
import { promisify } from "util";
import { getDatabase } from "../../config/database";
import { ingressNetworkName, NGINX_CONTAINER } from "../../shared/ingressNames";
import { logger } from "../../shared/logger";

const execFileAsync = promisify(execFile);

/** Docker side of the per-project ingress networks (S9): create the network, put nginx on it,
 *  remove it with the project. Which containers join it is the deployment's business
 *  (deployments/compose/networking.ts). */

async function docker(args: string[]): Promise<string> {
  try {
    return (await execFileAsync("docker", args, { timeout: 15_000 })).stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || (err instanceof Error ? err.message : String(err)));
  }
}

const alreadyThere = (err: unknown): boolean => /already exists|already connected|endpoint with name .* already exists/i.test(err instanceof Error ? err.message : String(err));
const notThere = (err: unknown): boolean => /No such (network|container|object)|is not connected|not found/i.test(err instanceof Error ? err.message : String(err));

async function networkExists(name: string): Promise<boolean> {
  try {
    await docker(["network", "inspect", name, "--format", "{{.Id}}"]);
    return true;
  } catch (err) {
    if (notThere(err)) return false;
    throw err;
  }
}

/** The networks nginx is on now. A recreated nginx container starts with none of the ingress
 *  networks, so this is read again whenever nginx's config is applied. */
async function nginxNetworks(): Promise<Set<string>> {
  const raw = await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", NGINX_CONTAINER]);
  return new Set(Object.keys(JSON.parse(raw) as Record<string, unknown>));
}

async function connectNginx(network: string, joined?: Set<string>): Promise<void> {
  if ((joined ?? await nginxNetworks()).has(network)) return;
  try {
    await docker(["network", "connect", network, NGINX_CONTAINER]);
  } catch (err) {
    if (!alreadyThere(err)) throw err;
  }
}

/** Creates the project's ingress network if it is missing and puts nginx on it. Safe to repeat. Without
 *  nginx (not started yet, or being recreated) the network is still created: a deploy must not depend on
 *  nginx, and connectNginxToIngressNetworks puts it on the network when its config is next applied. */
export async function ensureIngressNetwork(projectId: number): Promise<void> {
  const name = ingressNetworkName(projectId);
  if (!(await networkExists(name))) {
    try {
      await docker(["network", "create", "--driver", "bridge",
        "--label", "com.stackport.managed=ingress", "--label", `com.stackport.project-id=${projectId}`, name]);
    } catch (err) {
      if (!alreadyThere(err)) throw err;
    }
  }
  try {
    await connectNginx(name);
  } catch (err) {
    logger.warn({ network: name, reason: err instanceof Error ? err.message : String(err) }, "ingress.nginx-connect.deferred");
  }
}

/** Projects that have a domain or TCP exposure pointing at a service. */
function routedProjectIds(): number[] {
  const rows = getDatabase().prepare(
    `SELECT project_id AS id FROM project_domains WHERE service <> ''
     UNION SELECT project_id AS id FROM tcp_exposures WHERE service <> ''`
  ).all() as { id: number }[];
  return rows.map((row) => row.id);
}

/** Puts nginx back on every routed project's ingress network. Best effort: a missing nginx or
 *  network is reported to the log, not thrown, because the deploy that creates it comes later. */
export async function connectNginxToIngressNetworks(): Promise<void> {
  let joined: Set<string>;
  try { joined = await nginxNetworks(); }
  catch (err) { logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "ingress.nginx-networks.skipped"); return; }
  for (const id of routedProjectIds()) {
    const name = ingressNetworkName(id);
    try {
      if (!(await networkExists(name))) continue; // created by the project's next deploy
      await connectNginx(name, joined);
    } catch (err) {
      logger.warn({ network: name, reason: err instanceof Error ? err.message : String(err) }, "ingress.nginx-connect.failed");
    }
  }
}

/** Takes nginx off the network and deletes it. The network cannot go while a container is
 *  still on it (a project that was removed from Stackport but not stopped), so that case is
 *  reported and left for the next cleanup. */
export async function removeIngressNetwork(projectId: number): Promise<void> {
  const name = ingressNetworkName(projectId);
  try {
    await docker(["network", "disconnect", "--force", name, NGINX_CONTAINER]);
  } catch (err) {
    if (!notThere(err)) logger.warn({ network: name, reason: err instanceof Error ? err.message : String(err) }, "ingress.network-disconnect.failed");
  }
  try {
    await docker(["network", "rm", name]);
  } catch (err) {
    if (!notThere(err)) logger.warn({ network: name, reason: err instanceof Error ? err.message : String(err) }, "ingress.network-remove.failed");
  }
}
