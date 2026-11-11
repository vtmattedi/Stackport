import { execFile } from "child_process";
import { promisify } from "util";
import { GROUP_NETWORK_PREFIX, groupAlias, groupNetworkName } from "../../../shared/networkGroups";

const execFileAsync = promisify(execFile);

/** Docker side of network groups. Containers are connected to the group network with
 *  `docker network connect --alias`, not through the Compose file: a Compose-declared network also
 *  gives the service its plain name there, and `db` in one project would then answer for `db` in
 *  another. Connected this way the only names on the group network are the alias (`db.p7`) and the
 *  container's own unique name. The deploy re-applies it after every `up`. */

export type GroupDocker = (args: string[]) => Promise<string>;

export const dockerCli: GroupDocker = async (args) => {
  try {
    return (await execFileAsync("docker", args, { timeout: 15_000 })).stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || (err instanceof Error ? err.message : String(err)));
  }
};

const missing = (err: unknown): boolean => /No such (network|container|object)|is not connected|not found/i.test(err instanceof Error ? err.message : String(err));
const duplicate = (err: unknown): boolean => /already exists|already connected/i.test(err instanceof Error ? err.message : String(err));

export interface GroupSync {
  projectId: number;
  /** The Compose project name the containers are labelled with. */
  composeProject: string;
  group: string | null;
  services: string[];
}

interface Container { id: string; service: string; networks: Record<string, { Aliases?: string[] | null }> }

async function projectContainers(docker: GroupDocker, composeProject: string): Promise<Container[]> {
  const ids = (await docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${composeProject}`])).trim().split(/\s+/).filter(Boolean);
  const containers: Container[] = [];
  for (const id of ids) {
    const raw = await docker(["inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}}|{{json .NetworkSettings.Networks}}', id]);
    const split = raw.trim().indexOf("|");
    containers.push({ id, service: raw.trim().slice(0, split), networks: JSON.parse(raw.trim().slice(split + 1)) as Container["networks"] });
  }
  return containers;
}

async function ensureNetwork(docker: GroupDocker, name: string): Promise<void> {
  try {
    await docker(["network", "inspect", name, "--format", "{{.Id}}"]);
  } catch (err) {
    if (!missing(err)) throw err;
    try {
      await docker(["network", "create", "--driver", "bridge", "--label", "com.stackport.managed=group", name]);
    } catch (createErr) {
      if (!duplicate(createErr)) throw createErr;
    }
  }
}

/** Group networks nothing is connected to any more. */
export async function pruneGroupNetworks(docker: GroupDocker = dockerCli): Promise<void> {
  const names = (await docker(["network", "ls", "--filter", "label=com.stackport.managed=group", "--format", "{{.Name}}"])).trim().split(/\s+/).filter((n) => n.startsWith(GROUP_NETWORK_PREFIX));
  for (const name of names) {
    try {
      const inUse = (await docker(["network", "inspect", name, "--format", "{{len .Containers}}"])).trim();
      if (inUse === "0") await docker(["network", "rm", name]);
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }
}

/** Brings the project's running containers in line with its membership: the joined services are on
 *  the group's network under their alias; every other container is on no group network. */
export async function syncGroupNetwork(sync: GroupSync, docker: GroupDocker = dockerCli): Promise<void> {
  const wanted = sync.group && sync.services.length ? groupNetworkName(sync.group) : null;
  for (const container of await projectContainers(docker, sync.composeProject)) {
    const joins = wanted !== null && sync.services.includes(container.service);
    const alias = groupAlias(sync.projectId, container.service);
    for (const network of Object.keys(container.networks).filter((n) => n.startsWith(GROUP_NETWORK_PREFIX))) {
      // eslint-disable-next-line security/detect-object-injection -- keys are Docker network names; the lookups only read.
      if (joins && network === wanted && container.networks[network]?.Aliases?.includes(alias)) continue;
      try { await docker(["network", "disconnect", network, container.id]); }
      catch (err) { if (!missing(err)) throw err; }
    }
    if (joins && wanted) {
      // eslint-disable-next-line security/detect-object-injection -- keys are Docker network names; the lookups only read.
      if (container.networks[wanted]?.Aliases?.includes(alias)) continue;
      await ensureNetwork(docker, wanted);
      try { await docker(["network", "connect", "--alias", alias, wanted, container.id]); }
      catch (err) { if (!duplicate(err)) throw err; }
    }
  }
  await pruneGroupNetworks(docker);
}
