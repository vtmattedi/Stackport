import * as fs from "fs/promises";
import * as path from "path";
import { loadYamlDoc, dumpYamlDoc } from "./composeYaml";

/** The Docker network nginx (stackport-nginx) and the StackPort app itself both join
 *  (docker-compose.system.yml) — reaching a managed project's service by this shared
 *  network + the service's own Docker DNS name is what replaces the old
 *  {{SP:AUTO}}/port-hiding host-port model (Phase 1.7). Declared with a fixed `name:`
 *  (not the compose-project-scoped default) so it can be referenced as `external: true`
 *  from every managed project's own, separate compose project. */
export const STACKPORT_PROXY_NETWORK = "stackport-proxy";

/** StackPort-owned augmentation, ephemeral — parsed, mutated, and re-dumped, then
 *  written straight into the working-tree checkout, never committed (same philosophy
 *  the old SP:AUTO/port-hiding rewrites used, and for the same reason: git operations
 *  in ensureRepo wipe it back to the plain source file on every fresh pull, so this
 *  re-applies on every runCompose call rather than persisting once).
 *
 *  For each named service: sets `networks: ["default", "stackport-proxy"]` — "default"
 *  must be listed explicitly, not just implied, because an explicit `networks:` list on
 *  a service *replaces* Compose's implicit default-network attachment rather than
 *  adding to it; dropping "default" would cut the service off from its own project's
 *  other containers (e.g. its own database). */
export async function applyStackportProxyNetwork(
  repoPath: string,
  composeFile: string,
  services: string[]
): Promise<{ ok: boolean; message: string }> {
  const filePath = path.join(repoPath, composeFile);
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
  for (const name of services) {
    const service = (servicesDoc as Record<string, unknown>)[name];
    if (!service || typeof service !== "object") continue; // policy/existence validation is the caller's job, not this rewrite's
    const serviceObj = service as Record<string, unknown>;
    const desired = ["default", STACKPORT_PROXY_NETWORK];
    const current = serviceObj["networks"];
    const currentList = Array.isArray(current) ? current.filter((n): n is string => typeof n === "string") : null;
    if (currentList && desired.every((n) => currentList.includes(n)) && currentList.length === desired.length) continue;
    serviceObj["networks"] = desired;
    changed = true;
  }

  const topNetworks = (root["networks"] && typeof root["networks"] === "object") ? root["networks"] as Record<string, unknown> : {};
  const existingProxyNetwork = topNetworks[STACKPORT_PROXY_NETWORK];
  const proxyNetworkDeclared = !!existingProxyNetwork && typeof existingProxyNetwork === "object"
    && (existingProxyNetwork as Record<string, unknown>)["external"] === true;
  if (!proxyNetworkDeclared) {
    topNetworks[STACKPORT_PROXY_NETWORK] = { external: true, name: STACKPORT_PROXY_NETWORK };
    root["networks"] = topNetworks;
    changed = true;
  }

  if (!changed) return { ok: true, message: "" };

  try {
    await fs.writeFile(filePath, dumpYamlDoc(doc), "utf8");
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}\n` };
  }
}
