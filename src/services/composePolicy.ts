import * as path from "path";
import { splitPortSpec } from "./composeYaml";

/** StackPort's security/exposure boundary for managed-project compose files: the
 *  Phase 1.3 directives that let a container escape into host/StackPort authority
 *  (SP_dockerization.md §6), plus the Phase 1.7 hard cutover — `ports:` (any
 *  host-port publication) is rejected outright, never silently rewritten. Routing is
 *  domain -> service -> container_port instead (project_domains.service/
 *  container_port, composeNetworking.ts's stackport-proxy network attachment) —
 *  services declare `expose:` if anything, not `ports:`. */

const DANGEROUS_HOST_ROOTS = ["/etc", "/proc", "/sys", "/run", "/var/run"];
const DANGEROUS_CAPS = new Set(["ALL", "SYS_ADMIN"]);

function isPathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith(".");
}

function isDangerousHostPath(hostPath: string): boolean {
  if (!isPathLike(hostPath)) return false; // a named volume reference, not a bind mount
  const normalized = path.posix.normalize(hostPath);
  if (normalized === "/") return true;
  if (normalized.toLowerCase().includes("docker.sock")) return true;
  return DANGEROUS_HOST_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function shortFormVolumeHostPath(entry: string): string | null {
  const parts = splitPortSpec(entry);
  if (parts.length < 2) return null; // a bare container-path entry, e.g. "/data" — no host side at all
  return parts[0];
}

function longFormVolumeHostPath(entry: Record<string, unknown>): string | null {
  const source = entry["source"];
  return typeof source === "string" ? source : null;
}

/** One rule a service breaks, with what to change. `key` is the Compose key under
 *  the service (`ports`, `volumes`, ...). */
export interface PolicyViolation {
  service: string;
  key: string;
  problem: string;
  fix: string;
}

/** The single-line form used in deploy logs. */
export function formatPolicyViolation(v: PolicyViolation): string {
  return `services.${v.service}.${v.key}: ${v.problem} ${v.fix}`;
}

function checkService(name: string, service: Record<string, unknown>, violations: PolicyViolation[]): void {
  const add = (key: string, problem: string, fix: string): number => violations.push({ service: name, key, problem, fix });

  const privileged = service["privileged"];
  if (privileged === true || privileged === "true") {
    add("privileged", "privileged containers are not allowed for managed projects.", 'Remove "privileged: true".');
  }

  for (const [field, label] of [["network_mode", "network_mode: host"], ["pid", "pid: host"], ["ipc", "ipc: host"]] as const) {
    if (service[field] === "host") {
      add(field, `"${label}" is not allowed for managed projects.`, `Remove "${field}: host"; services reach each other by name on the project network.`);
    }
  }

  const capAdd = service["cap_add"];
  if (Array.isArray(capAdd)) {
    for (const cap of capAdd) {
      if (typeof cap === "string" && DANGEROUS_CAPS.has(cap.toUpperCase())) {
        add("cap_add", `capability "${cap}" is not allowed for managed projects.`, `Remove "${cap}" and add only the specific capabilities the service needs.`);
      }
    }
  }

  const devices = service["devices"];
  if (Array.isArray(devices) && devices.length > 0) {
    add("devices", "device access is not allowed for managed projects.", 'Remove "devices:".');
  }

  const ports = service["ports"];
  if (Array.isArray(ports) && ports.length > 0) {
    add(
      "ports",
      "host port publication is not allowed for managed projects.",
      `Use "expose:" for the container port instead, then route a domain to the service ` +
      `(or add a TCP port) in the project's Domains tab.`,
    );
  }

  const volumes = service["volumes"];
  if (Array.isArray(volumes)) {
    for (const entry of volumes) {
      const hostPath = typeof entry === "string"
        ? shortFormVolumeHostPath(entry)
        : entry && typeof entry === "object"
          ? longFormVolumeHostPath(entry as Record<string, unknown>)
          : null;
      if (hostPath && isDangerousHostPath(hostPath)) {
        add("volumes", `mounting host path "${hostPath}" is not allowed for managed projects.`, "Use a named volume or a path inside the project folder.");
      }
    }
  }
}

/** Walks a parsed compose doc's services and returns every policy violation found,
 *  service-qualified and actionable. `ok: true` (empty violations) means the file may
 *  proceed to `up`. Never mutates the input — a violation is reported and the deploy
 *  is rejected, never silently stripped/rewritten (SP_dockerization.md §6, §14). */
export function validateComposePolicy(doc: unknown): { ok: boolean; violations: PolicyViolation[] } {
  const violations: PolicyViolation[] = [];
  if (!doc || typeof doc !== "object") return { ok: true, violations };
  const services = (doc as Record<string, unknown>)["services"];
  if (!services || typeof services !== "object") return { ok: true, violations };

  for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
    if (!service || typeof service !== "object") continue;
    checkService(name, service as Record<string, unknown>, violations);
  }

  return { ok: violations.length === 0, violations };
}

/** Where the project's files live; bind mounts must stay inside it. */
export interface ResolvedPolicyContext {
  projectDir: string;
}

/** True when `target` is `dir` or inside it. Compose resolves relative paths to
 *  absolute ones in the resolved config, using the host's path style, so both POSIX and
 *  Windows paths are handled and compared case-insensitively on Windows. */
function isInsideDir(target: string, dir: string): boolean {
  const win = /^[A-Za-z]:[\\/]/.test(dir);
  const lib = win ? path.win32 : path.posix;
  const norm = (value: string): string => (win ? lib.normalize(value).toLowerCase() : lib.normalize(value));
  if (!lib.isAbsolute(target)) return false;
  const relative = lib.relative(norm(dir), norm(target));
  return relative === "" || (!relative.startsWith("..") && !lib.isAbsolute(relative));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

type Add = (service: string, key: string, problem: string, fix: string) => void;

/** Bind mounts must stay inside the project folder (a, S1). Named volumes and tmpfs
 *  are fine; any other mount type is not on the allowlist. */
function checkResolvedVolumes(name: string, service: Record<string, unknown>, context: ResolvedPolicyContext, add: Add): void {
  const volumes = service["volumes"];
  if (!Array.isArray(volumes)) return;
  for (const entry of volumes) {
    const mount = asRecord(entry);
    if (!mount) continue;
    const type = mount["type"];
    if (type === "volume" || type === "tmpfs") continue;
    const source = typeof mount["source"] === "string" ? mount["source"] : "";
    if (type !== "bind") {
      add(name, "volumes", `mount type "${String(type)}" is not allowed for managed projects.`, "Use a named volume or a path inside the project folder.");
    } else if (!isInsideDir(source, context.projectDir) && !isDangerousHostPath(source)) { // the denylist already reports those
      add(name, "volumes", `mounting host path "${source}" is not allowed for managed projects: it is outside the project folder.`, "Use a named volume or a path inside the project folder.");
    }
  }
}

/** Checks the output of `docker compose config --format json`: variables resolved,
 *  `include:` and `extends:` merged, so a value the raw YAML only spelled indirectly
 *  (`${PRIV:-true}`, an included file) is seen as Compose will run it. Anything the
 *  rules below do not allow is a violation (S1). The raw-YAML check above stays in
 *  place as the first line of defence. */
export function validateResolvedComposePolicy(resolved: unknown, context: ResolvedPolicyContext): { ok: boolean; violations: PolicyViolation[] } {
  // Resolved values take the same denylist checks as the raw file; the allowlist rules
  // below close what a denylist cannot.
  const violations = [...validateComposePolicy(resolved).violations];
  const add: Add = (service, key, problem, fix) => { violations.push({ service, key, problem, fix }); };
  const services = asRecord(asRecord(resolved)?.["services"]);
  for (const [name, value] of Object.entries(services ?? {})) {
    const service = asRecord(value);
    if (!service) continue;
    checkResolvedVolumes(name, service, context, add);
  }
  // The denylist already flags dangerous host paths; keep one violation per mount.
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.service}|${v.key}|${v.problem}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { ok: unique.length === 0, violations: unique };
}
