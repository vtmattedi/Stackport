/* eslint-disable security/detect-object-injection -- keys are our own network name or names read from the same object; the lookups only read or write own entries. */
import * as fs from "fs/promises";
import * as path from "path";
import { loadYamlDoc, dumpYamlDoc } from "./yaml";
import { dockerCli, type GroupDocker } from "./groupNetworks";
import { INGRESS_NETWORK, ingressAlias, LEGACY_INGRESS_PREFIX } from "../../../shared/ingressNames";

/** The network nginx and every routed service share. Declared by the system stack, so nginx is always on it. */
export const STACKPORT_PROXY_NETWORK = INGRESS_NETWORK;

const missing = (err: unknown): boolean => /No such (network|container|object)|is not connected|not found/i.test(err instanceof Error ? err.message : String(err));

/** A route can be added after deployment, and a project that predates this release has to be moved over.
 *  Puts each running container of the routed services on the shared network under the alias nginx uses
 *  (`sp<id>-<service>`) and, for compatibility, its plain name; applyStackportProxyNetwork keeps it there
 *  across Compose recreations. A container that sat on a per-project network from 1.3.0 is taken off it
 *  only after it is on the shared one, so there is no moment without a route.
 *
 *  Returns how many containers were already or are now in place. Throws on the first Docker error so the
 *  caller can report which project failed. */
export async function connectRunningProxyServices(projectId: number, projectName: string, services: string[], docker: GroupDocker = dockerCli): Promise<number> {
  let placed = 0;
  for (const service of services) {
    const ids = (await docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--filter", `label=com.docker.compose.service=${service}`])).trim().split(/\s+/).filter(Boolean);
    const alias = ingressAlias(projectId, service);
    for (const id of ids) {
      const networks = JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", id])) as Record<string, { Aliases?: string[] | null }>;
      if (!networks[INGRESS_NETWORK]?.Aliases?.includes(alias)) {
        // Docker cannot add an alias to a connected endpoint; reconnecting is a moment on this network only.
        if (networks[INGRESS_NETWORK]) {
          try { await docker(["network", "disconnect", INGRESS_NETWORK, id]); }
          catch (err) { if (!missing(err)) throw err; }
        }
        await docker(["network", "connect", "--alias", alias, "--alias", service, INGRESS_NETWORK, id]);
      }
      for (const name of Object.keys(networks).filter((n) => n.startsWith(LEGACY_INGRESS_PREFIX))) {
        try { await docker(["network", "disconnect", name, id]); }
        catch (err) { if (!missing(err)) throw err; }
      }
      placed += 1;
    }
  }
  return placed;
}

/** Services' `networks:` in object form, keeping what the file said (an empty list entry is `{}`). */
function networksAsObject(current: unknown): Record<string, unknown> | null {
  if (Array.isArray(current)) return Object.fromEntries(current.filter((n): n is string => typeof n === "string").map((n) => [n, {}]));
  if (current && typeof current === "object") return { ...(current as Record<string, unknown>) };
  return null;
}

const isLegacy = (name: string): boolean => name.startsWith(LEGACY_INGRESS_PREFIX);

/** StackPort-owned augmentation, ephemeral — parsed, mutated, and re-dumped, then
 *  written straight into the working-tree checkout, never committed (same philosophy
 *  the old SP:AUTO/port-hiding rewrites used, and for the same reason: git operations
 *  in ensureRepo wipe it back to the plain source file on every fresh pull, so this
 *  re-applies on every runCompose call rather than persisting once).
 *
 *  Attaches each routed service to the shared ingress network under the alias sp<id>-<service>, so nginx
 *  never has to tell two projects' `web` services apart. An explicit `networks:` list on a service
 *  *replaces* Compose's implicit default-network attachment rather than adding to it, so "default"
 *  is added alongside when networking was implicit; dropping it would cut the service off from
 *  its own project's other containers (e.g. its own database). A per-project network that 1.3.0 wrote into
 *  the file is removed. */
export async function applyStackportProxyNetwork(
  repoPath: string,
  composeFile: string,
  services: string[],
  projectId: number
): Promise<{ ok: boolean; message: string }> {
  const filePath = path.join(repoPath, composeFile);
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are inside a project's checkout: its directory plus a Compose file name picked from the files found there; any path a project supplies goes through resolveContainedPath first.
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}\n` };
  }

  let doc: unknown;
  try {
    doc = loadYamlDoc(raw);
  } catch (err) {
    return { ok: false, message: `Failed to parse compose file: ${err instanceof Error ? err.message : String(err)}\n` };
  }
  if (!doc || typeof doc !== "object") {
    return { ok: false, message: "Compose file has no top-level services/networks structure.\n" };
  }

  const root = doc as Record<string, unknown>;
  const servicesDoc = root["services"];
  if (!servicesDoc || typeof servicesDoc !== "object") {
    return { ok: false, message: "Compose file has no services: block.\n" };
  }

  let changed = false;
  // A file rewritten by 1.3.0 still names a per-project network; it must not stay there.
  for (const service of Object.values(servicesDoc as Record<string, unknown>)) {
    if (!service || typeof service !== "object") continue;
    const serviceObj = service as Record<string, unknown>;
    const current = serviceObj["networks"];
    if (Array.isArray(current) && current.some((n) => typeof n === "string" && isLegacy(n))) {
      const rest = current.filter((n) => !(typeof n === "string" && isLegacy(n)));
      if (rest.length) serviceObj["networks"] = rest; else delete serviceObj["networks"];
      changed = true;
    } else if (current && typeof current === "object" && !Array.isArray(current) && Object.keys(current).some(isLegacy)) {
      const rest = Object.fromEntries(Object.entries(current as Record<string, unknown>).filter(([name]) => !isLegacy(name)));
      if (Object.keys(rest).length) serviceObj["networks"] = rest; else delete serviceObj["networks"];
      changed = true;
    }
  }

  for (const name of services) {
    const service = (servicesDoc as Record<string, unknown>)[name];
    if (!service || typeof service !== "object") continue; // policy/existence validation is the caller's job, not this rewrite's
    const serviceObj = service as Record<string, unknown>;
    const attached = networksAsObject(serviceObj["networks"]) ?? { default: {} };
    const wanted = { aliases: [ingressAlias(projectId, name)] };
    if (JSON.stringify(attached[INGRESS_NETWORK]) !== JSON.stringify(wanted)) {
      attached[INGRESS_NETWORK] = wanted;
      changed = true;
    }
    // Compose treats `networks` as a list only when no entry carries options; keep one shape.
    if (!(serviceObj["networks"] && typeof serviceObj["networks"] === "object" && !Array.isArray(serviceObj["networks"]))) changed = true;
    serviceObj["networks"] = attached;
  }

  const topNetworks = (root["networks"] && typeof root["networks"] === "object") ? { ...(root["networks"] as Record<string, unknown>) } : {};
  for (const name of Object.keys(topNetworks).filter(isLegacy)) { delete topNetworks[name]; changed = true; }
  if (services.length > 0) {
    const existing = topNetworks[INGRESS_NETWORK];
    const declared = !!existing && typeof existing === "object"
      && (existing as Record<string, unknown>)["external"] === true
      && (existing as Record<string, unknown>)["name"] === INGRESS_NETWORK;
    if (!declared) {
      topNetworks[INGRESS_NETWORK] = { external: true, name: INGRESS_NETWORK };
      changed = true;
    }
  }
  if (Object.keys(topNetworks).length) root["networks"] = topNetworks; else if ("networks" in root) delete root["networks"];

  if (!changed) return { ok: true, message: "" };

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are inside a project's checkout: its directory plus a Compose file name picked from the files found there; any path a project supplies goes through resolveContainedPath first.
    await fs.writeFile(filePath, dumpYamlDoc(doc), "utf8");
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}\n` };
  }
}
