import { execFile } from "child_process";
import { promisify } from "util";
import { INGRESS_NETWORK, LEGACY_INGRESS_PREFIX, legacyIngressNetworkName, NGINX_CONTAINER } from "../../shared/ingressNames";
import { logger } from "../../shared/logger";

const execFileAsync = promisify(execFile);

/** Docker side of the shared ingress network (see shared/ingressNames.ts). */

export type DockerRun = (args: string[]) => Promise<string>;

export const dockerRun: DockerRun = async (args) => {
  try {
    return (await execFileAsync("docker", args, { timeout: 15_000 })).stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || (err instanceof Error ? err.message : String(err)));
  }
};

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const notThere = (err: unknown): boolean => /No such (network|container|object)|is not connected|not found/i.test(text(err));
const alreadyThere = (err: unknown): boolean => /already exists/i.test(text(err));

/** The network nginx and the routed services share. The system stack declares it, so it normally exists;
 *  this creates it if someone removed it. */
export async function ensureSharedIngressNetwork(run: DockerRun = dockerRun): Promise<void> {
  try {
    await run(["network", "inspect", INGRESS_NETWORK, "--format", "{{.Id}}"]);
    return;
  } catch (err) {
    if (!notThere(err)) throw err;
  }
  try {
    await run(["network", "create", "--driver", "bridge", INGRESS_NETWORK]);
  } catch (err) {
    if (!alreadyThere(err)) throw err;
  }
}

export interface LegacyCleanup { removed: string[]; kept: { name: string; reason: string }[] }

/** Removes the per-project networks 1.3.0 created, once nothing but nginx is on them. They hold slices of
 *  Docker's address pool, so removing them gives that room back. A network that still has another container
 *  (a service not moved yet, a TCP proxy) is left for the next run. Never throws. */
export async function removeLegacyIngressNetworks(run: DockerRun = dockerRun, only?: string): Promise<LegacyCleanup> {
  const result: LegacyCleanup = { removed: [], kept: [] };
  let names: string[];
  try {
    names = (await run(["network", "ls", "--format", "{{.Name}}"])).split(/\s+/).filter((n) => n.startsWith(LEGACY_INGRESS_PREFIX) && (only === undefined || n === only));
  } catch (err) {
    logger.warn({ reason: text(err) }, "ingress.legacy-cleanup.failed");
    return result;
  }
  for (const name of names) {
    try {
      const members = (await run(["network", "inspect", name, "--format", "{{range $id, $c := .Containers}}{{$c.Name}} {{end}}"])).split(/\s+/).filter(Boolean);
      const others = members.filter((m) => m !== NGINX_CONTAINER);
      if (others.length) { result.kept.push({ name, reason: `still has ${others.join(", ")}` }); continue; }
      if (members.includes(NGINX_CONTAINER)) {
        try { await run(["network", "disconnect", "--force", name, NGINX_CONTAINER]); }
        catch (err) { if (!notThere(err)) throw err; }
      }
      await run(["network", "rm", name]);
      result.removed.push(name);
    } catch (err) {
      if (notThere(err)) continue;
      result.kept.push({ name, reason: text(err) });
    }
  }
  if (result.removed.length || result.kept.length) {
    const line = `[ingress] legacy per-project networks: removed ${result.removed.length}, kept ${result.kept.length}${result.kept.length ? ` (${result.kept.map((k) => `${k.name}: ${k.reason}`).join("; ")})` : ""}`;
    // Kept ones are the ones an admin may need to act on; the plain line is for anyone reading docker logs.
    if (result.kept.length) logger.warn({ removed: result.removed, kept: result.kept }, line);
    else logger.info({ removed: result.removed }, line);
  }
  return result;
}

/** Removes one project's legacy network, when a project is deleted. */
export async function removeIngressNetwork(projectId: number, run: DockerRun = dockerRun): Promise<void> {
  await removeLegacyIngressNetworks(run, legacyIngressNetworkName(projectId));
}
