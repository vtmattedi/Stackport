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

function checkService(name: string, service: Record<string, unknown>, violations: string[]): void {
  const privileged = service["privileged"];
  if (privileged === true || privileged === "true") {
    violations.push(`services.${name}.privileged: privileged containers are not allowed for managed projects.`);
  }

  for (const [field, label] of [["network_mode", "network_mode: host"], ["pid", "pid: host"], ["ipc", "ipc: host"]] as const) {
    if (service[field] === "host") {
      violations.push(`services.${name}.${field}: "${label}" is not allowed for managed projects.`);
    }
  }

  const capAdd = service["cap_add"];
  if (Array.isArray(capAdd)) {
    for (const cap of capAdd) {
      if (typeof cap === "string" && DANGEROUS_CAPS.has(cap.toUpperCase())) {
        violations.push(`services.${name}.cap_add: capability "${cap}" is not allowed for managed projects.`);
      }
    }
  }

  const devices = service["devices"];
  if (Array.isArray(devices) && devices.length > 0) {
    violations.push(`services.${name}.devices: device access is not allowed for managed projects.`);
  }

  const ports = service["ports"];
  if (Array.isArray(ports) && ports.length > 0) {
    violations.push(
      `services.${name}.ports: host port publication is not allowed for managed projects. ` +
      `Use "expose:" for the container-internal port instead, and configure the public route ` +
      `(domain -> service -> container port) on the project's domain settings.`
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
        violations.push(`services.${name}.volumes: mounting host path "${hostPath}" is not allowed for managed projects.`);
      }
    }
  }
}

/** Walks a parsed compose doc's services and returns every policy violation found,
 *  service-qualified and actionable. `ok: true` (empty violations) means the file may
 *  proceed to `up`. Never mutates the input — a violation is reported and the deploy
 *  is rejected, never silently stripped/rewritten (SP_dockerization.md §6, §14). */
export function validateComposePolicy(doc: unknown): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (!doc || typeof doc !== "object") return { ok: true, violations };
  const services = (doc as Record<string, unknown>)["services"];
  if (!services || typeof services !== "object") return { ok: true, violations };

  for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
    if (!service || typeof service !== "object") continue;
    checkService(name, service as Record<string, unknown>, violations);
  }

  return { ok: violations.length === 0, violations };
}
