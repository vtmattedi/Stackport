import { splitPortSpec } from "./composeYaml";
import { normalizeRelativePath } from "../utils/safePath";

export interface ComposeIngressTarget {
  service: string;
  containerPort: number;
}

/** Read normalized `docker compose config` output. Published host ports are never
 *  route targets. UDP endpoints are excluded from the HTTP reverse proxy. */
export function extractComposeIngressTargets(config: unknown): ComposeIngressTarget[] {
  if (!config || typeof config !== "object") return [];
  const services = (config as Record<string, unknown>)["services"];
  if (!services || typeof services !== "object") return [];
  const targets: ComposeIngressTarget[] = [];
  for (const [service, raw] of Object.entries(services)) {
    if (!raw || typeof raw !== "object") continue;
    const definition = raw as Record<string, unknown>;
    const ports = new Set<number>();
    const add = (value: unknown) => {
      const match = String(value ?? "").match(/^(\d+)(?:-(\d+))?(?:\/tcp)?$/);
      if (!match) return;
      const start = Number(match[1]), end = Number(match[2] ?? start);
      if (start < 1 || end > 65535 || end < start || end - start > 255) return;
      for (let port = start; port <= end; port++) ports.add(port);
    };
    if (Array.isArray(definition["expose"])) definition["expose"].forEach(add);
    if (Array.isArray(definition["ports"])) {
      for (const port of definition["ports"]) {
        if (port && typeof port === "object" && port.protocol !== "udp") add(port.target);
      }
    }
    if (!ports.size && definition["environment"] && typeof definition["environment"] === "object") {
      const env = definition["environment"] as Record<string, unknown>;
      add(env["PORT"] ?? env["HTTP_PORT"]);
    }
    for (const containerPort of [...ports].sort((a, b) => a - b)) targets.push({ service, containerPort });
  }
  return targets.sort((a, b) => a.service.localeCompare(b.service) || a.containerPort - b.containerPort);
}

function rawPortTarget(value: unknown): { target: unknown; protocol?: string } | null {
  if (value && typeof value === "object") return value as { target: unknown; protocol?: string };
  if (typeof value === "number") return { target: value };
  if (typeof value !== "string") return null;
  const [spec, protocol] = value.split("/");
  const target = splitPortSpec(spec).pop();
  return target === undefined ? null : { target, protocol };
}

/** Fallback for a compose file `docker compose config` can't resolve yet — usually
 *  because an `env_file:` it references is only written at deploy time. Reads the
 *  raw YAML instead, so interpolated ports (`${PORT}`) simply don't show up. */
export function extractRawComposeIngressTargets(doc: unknown): ComposeIngressTarget[] {
  if (!doc || typeof doc !== "object") return [];
  const services = (doc as Record<string, unknown>)["services"];
  if (!services || typeof services !== "object") return [];
  const normalized: Record<string, unknown> = {};
  for (const [service, raw] of Object.entries(services)) {
    if (!raw || typeof raw !== "object") continue;
    const definition = raw as Record<string, unknown>;
    const environment = Array.isArray(definition["environment"])
      ? Object.fromEntries(definition["environment"].map((entry) => String(entry).split(/=(.*)/s).slice(0, 2)))
      : definition["environment"];
    normalized[service] = {
      expose: Array.isArray(definition["expose"]) ? definition["expose"] : undefined,
      ports: Array.isArray(definition["ports"]) ? definition["ports"].map(rawPortTarget).filter(Boolean) : undefined,
      environment,
    };
  }
  return extractComposeIngressTargets({ services: normalized });
}

export interface ComposeEnvFileRef {
  path: string;
  required: boolean;
  services: string[];
}

/** Every `env_file:` the compose file points at, relative to the project root. */
export function extractComposeEnvFileRefs(doc: unknown): ComposeEnvFileRef[] {
  if (!doc || typeof doc !== "object") return [];
  const services = (doc as Record<string, unknown>)["services"];
  if (!services || typeof services !== "object") return [];
  const refs = new Map<string, ComposeEnvFileRef>();
  for (const [service, raw] of Object.entries(services)) {
    if (!raw || typeof raw !== "object") continue;
    const envFile = (raw as Record<string, unknown>)["env_file"];
    const entries = Array.isArray(envFile) ? envFile : envFile === undefined ? [] : [envFile];
    for (const entry of entries) {
      const rawPath = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as Record<string, unknown>)["path"] : null;
      if (typeof rawPath !== "string") continue;
      const relativePath = normalizeRelativePath(rawPath.replace(/^(\.\/)+/, ""));
      if (!relativePath) continue;
      const required = !(entry && typeof entry === "object" && (entry as Record<string, unknown>)["required"] === false);
      const ref = refs.get(relativePath) ?? { path: relativePath, required: false, services: [] };
      ref.required ||= required;
      if (!ref.services.includes(service)) ref.services.push(service);
      refs.set(relativePath, ref);
    }
  }
  return [...refs.values()].sort((a, b) => a.path.localeCompare(b.path));
}
