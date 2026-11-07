import * as fs from "fs/promises";
import * as path from "path";
import { loadYamlDoc, dumpYamlDoc } from "./yaml";
import { execFile } from "child_process";
import { promisify } from "util";
import { ingressAlias, ingressNetworkName } from "../../../shared/ingressNames";

const execFileAsync = promisify(execFile);

/** The shared network every routed project used to join (before per-project ingress networks, S9).
 *  Stackport no longer attaches it, and removes it from a Compose file an older release rewrote. */
export const STACKPORT_PROXY_NETWORK = "stackport-proxy";

/** A route can be added after deployment. Attach existing containers to the project's ingress
 *  network immediately, under the alias nginx uses, and take them off the old shared network;
 *  applyStackportProxyNetwork keeps the connection on the next Compose recreation. */
export async function connectRunningProxyServices(projectId: number, projectName: string, services: string[]): Promise<void> {
  const network = ingressNetworkName(projectId);
  for (const service of services) {
    const { stdout } = await execFileAsync("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--filter", `label=com.docker.compose.service=${service}`], { timeout: 12_000 });
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      const inspected = await execFileAsync("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", id], { timeout: 12_000 });
      const networks = JSON.parse(inspected.stdout) as Record<string, { Aliases?: string[] | null }>;
      const alias = ingressAlias(projectId, service);
      if (!networks[network]?.Aliases?.includes(alias)) {
        if (networks[network]) await execFileAsync("docker", ["network", "disconnect", network, id], { timeout: 12_000 });
        await execFileAsync("docker", ["network", "connect", "--alias", alias, network, id], { timeout: 12_000 });
      }
      if (networks[STACKPORT_PROXY_NETWORK]) {
        await execFileAsync("docker", ["network", "disconnect", STACKPORT_PROXY_NETWORK, id], { timeout: 12_000 }).catch(() => undefined);
      }
    }
  }
}

/** Services' `networks:` in object form, keeping what the file said (an empty list entry is `{}`). */
function networksAsObject(current: unknown): Record<string, unknown> | null {
  if (Array.isArray(current)) return Object.fromEntries(current.filter((n): n is string => typeof n === "string").map((n) => [n, {}]));
  if (current && typeof current === "object") return { ...(current as Record<string, unknown>) };
  return null;
}

/** StackPort-owned augmentation, ephemeral — parsed, mutated, and re-dumped, then
 *  written straight into the working-tree checkout, never committed (same philosophy
 *  the old SP:AUTO/port-hiding rewrites used, and for the same reason: git operations
 *  in ensureRepo wipe it back to the plain source file on every fresh pull, so this
 *  re-applies on every runCompose call rather than persisting once).
 *
 *  Attaches each routed service to the project's own ingress network (stackport-ingress-<id>,
 *  which only nginx and this project join) under the alias sp<id>-<service>, so nginx never has
 *  to tell two projects' `web` services apart (S9). An explicit `networks:` list on a service
 *  *replaces* Compose's implicit default-network attachment rather than adding to it, so "default"
 *  is added alongside when networking was implicit; dropping it would cut the service off from
 *  its own project's other containers (e.g. its own database). */
export async function applyStackportProxyNetwork(
  repoPath: string,
  composeFile: string,
  services: string[],
  projectId: number
): Promise<{ ok: boolean; message: string }> {
  const filePath = path.join(repoPath, composeFile);
  const ingress = ingressNetworkName(projectId);
  let raw: string;
  try {
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
  // A file an older release rewrote still joins the shared network; it must not keep sharing it.
  for (const service of Object.values(servicesDoc as Record<string, unknown>)) {
    if (!service || typeof service !== "object") continue;
    const serviceObj = service as Record<string, unknown>;
    const current = serviceObj["networks"];
    if (Array.isArray(current) && current.includes(STACKPORT_PROXY_NETWORK)) {
      const rest = current.filter((n) => n !== STACKPORT_PROXY_NETWORK);
      if (rest.length) serviceObj["networks"] = rest; else delete serviceObj["networks"];
      changed = true;
    } else if (current && typeof current === "object" && !Array.isArray(current) && STACKPORT_PROXY_NETWORK in current) {
      const rest = { ...(current as Record<string, unknown>) };
      delete rest[STACKPORT_PROXY_NETWORK];
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
    if (JSON.stringify(attached[ingress]) !== JSON.stringify(wanted)) {
      attached[ingress] = wanted;
      changed = true;
    }
    // Compose treats `networks` as a list only when no entry carries options; keep one shape.
    if (!(serviceObj["networks"] && typeof serviceObj["networks"] === "object" && !Array.isArray(serviceObj["networks"]))) changed = true;
    serviceObj["networks"] = attached;
  }

  const topNetworks = (root["networks"] && typeof root["networks"] === "object") ? { ...(root["networks"] as Record<string, unknown>) } : {};
  if (STACKPORT_PROXY_NETWORK in topNetworks) { delete topNetworks[STACKPORT_PROXY_NETWORK]; changed = true; }
  if (services.length > 0) {
    const existing = topNetworks[ingress];
    const declared = !!existing && typeof existing === "object"
      && (existing as Record<string, unknown>)["external"] === true
      && (existing as Record<string, unknown>)["name"] === ingress;
    if (!declared) {
      topNetworks[ingress] = { external: true, name: ingress };
      changed = true;
    }
  }
  if (Object.keys(topNetworks).length) root["networks"] = topNetworks; else if ("networks" in root) delete root["networks"];

  if (!changed) return { ok: true, message: "" };

  try {
    await fs.writeFile(filePath, dumpYamlDoc(doc), "utf8");
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}\n` };
  }
}
