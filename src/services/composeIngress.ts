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
