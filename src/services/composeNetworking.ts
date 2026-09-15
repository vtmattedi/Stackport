import * as fs from "fs/promises";
import * as path from "path";
import { loadYamlDoc, dumpYamlDoc } from "./composeYaml";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** A route can be added after deployment. Attach existing containers immediately;
 *  applyStackportProxyNetwork keeps the connection on the next Compose recreation. */
export async function connectRunningProxyServices(projectName: string, services: string[]): Promise<void> {
  for (const service of services) {
    const { stdout } = await execFileAsync("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--filter", `label=com.docker.compose.service=${service}`], { timeout: 12_000 });
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      const inspected = await execFileAsync("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", id], { timeout: 12_000 });
      const networks = JSON.parse(inspected.stdout) as Record<string, unknown>;
      if (!networks[STACKPORT_PROXY_NETWORK]) {
        await execFileAsync("docker", ["network", "connect", "--alias", service, STACKPORT_PROXY_NETWORK, id], { timeout: 12_000 });
      }
    }
  }
}

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
 *  For each named service: preserves explicit networks, or adds "default" alongside
 *  "stackport-proxy" when networking was implicit. An explicit `networks:` list on
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
    const current = serviceObj["networks"];
    if (Array.isArray(current)) {
      if (current.includes(STACKPORT_PROXY_NETWORK)) continue;
      serviceObj["networks"] = [...current, STACKPORT_PROXY_NETWORK];
    } else if (current && typeof current === "object") {
      if (STACKPORT_PROXY_NETWORK in current) continue;
      serviceObj["networks"] = { ...current, [STACKPORT_PROXY_NETWORK]: {} };
    } else {
      serviceObj["networks"] = ["default", STACKPORT_PROXY_NETWORK];
    }
    changed = true;
  }

  const topNetworks = (root["networks"] && typeof root["networks"] === "object") ? root["networks"] as Record<string, unknown> : {};
  const existingProxyNetwork = topNetworks[STACKPORT_PROXY_NETWORK];
  const proxyNetworkDeclared = !!existingProxyNetwork && typeof existingProxyNetwork === "object"
    && (existingProxyNetwork as Record<string, unknown>)["external"] === true
    && (existingProxyNetwork as Record<string, unknown>)["name"] === STACKPORT_PROXY_NETWORK;
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
