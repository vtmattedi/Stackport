import { getComposeStacksCached, getContainerListCached, getContainerStatsCached, getDiskUsageCached, getDockerVersionCached } from "../../../integrations/docker/statusCache";
import { getNginxLayerStatus } from "../../ingress/nginx/configWriter";
import { getNginxActiveStatusCached, getNginxVersionCached } from "../../ingress/nginx/statusCache";
import { getStorageState, getStorageThresholds } from "../../maintenance/storage/operations";
import { getCertbotStatus } from "../../ingress/certificates/operations";
import { getAppVersion } from "../../maintenance/version";

export function parseNdjson(s: string): Record<string, unknown>[] {
  return s
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; }
      catch { return []; }
    });
}

// "key1=val1,key2=val2=with=equals" → { key1: "val1", key2: "val2=with=equals" }
export function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const kv of s.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

export function labelIsTrue(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

// ── Docker ───────────────────────────────────────────────────────────────────

async function getDockerData() {
  const versionRes = await getDockerVersionCached();

  const unavailableStorage = { state: "unknown" as const, freeBytes: null, totalBytes: null, freePct: null, thresholds: getStorageThresholds() };
  if (versionRes.notFound) return { available: false, reason: "docker not installed", stacks: [], standalone: [], diskUsage: [], storage: unavailableStorage };
  if (!versionRes.ok)      return { available: false, reason: "Docker daemon not running", stacks: [], standalone: [], diskUsage: [], storage: unavailableStorage };

  let version = "unknown";
  try {
    const v = JSON.parse(versionRes.stdout) as Record<string, Record<string, string>>;
    version = v?.Client?.Version ?? v?.Server?.Version ?? "unknown";
  } catch { /* ignore */ }

  // Each of these is its own single-flighted, TTL'd cache (see dockerStatusCache.ts)
  // shared with the independent project-resource sampler — a poll tick here only
  // spawns a fresh subprocess when that particular cache has actually gone stale.
  const [psRes, statsRes, composeRes, dfRes] = await Promise.all([
    getContainerListCached(),
    getContainerStatsCached(),
    getComposeStacksCached(),
    getDiskUsageCached(),
  ]);

  const diskUsage = parseNdjson(dfRes.stdout).map((entry) => ({
    type:        String(entry.Type ?? ""),
    totalCount:  String(entry.TotalCount ?? "0"),
    active:      String(entry.Active ?? "0"),
    size:        String(entry.Size ?? "—"),
    reclaimable: String(entry.Reclaimable ?? "—"),
  }));

  // Stats map keyed by short container ID
  const statsMap: Record<string, { cpu: string; mem: string; memPerc: string; netIO: string; blockIO: string }> = {};
  parseNdjson(statsRes.stdout).forEach((s) => {
    const id = String(s.ID ?? "").slice(0, 12);
    // eslint-disable-next-line security/detect-object-injection -- keys are Docker container ids.
    statsMap[id] = {
      cpu:     String(s.CPUPerc ?? "—"),
      mem:     String(s.MemUsage ?? "—"),
      memPerc: String(s.MemPerc ?? "—"),
      netIO:   String(s.NetIO ?? "—"),
      blockIO: String(s.BlockIO ?? "—"),
    };
  });

  // Parse containers and annotate with compose labels
  interface ContainerEntry {
    id: string;
    name: string;
    service: string | null;
    image: string;
    state: string;
    status: string;
    ports: string;
    composeProject: string | null;
    healthCheckIgnored: boolean;
    stats: typeof statsMap[string] | null;
  }

  const allContainers: ContainerEntry[] = parseNdjson(psRes.stdout).map((c) => {
    const id = String(c.ID ?? "").slice(0, 12);
    const labels = parseLabels(String(c.Labels ?? ""));
    return {
      id,
      name:           String(c.Names ?? ""),
      service:        labels["com.docker.compose.service"] ?? null,
      image:          String(c.Image ?? ""),
      state:          String(c.State ?? ""),
      status:         String(c.Status ?? ""),
      ports:          String(c.Ports ?? ""),
      composeProject: labels["com.docker.compose.project"] ?? null,
      healthCheckIgnored: labelIsTrue(labels["com.stackport.health.ignore"]),
      // eslint-disable-next-line security/detect-object-injection -- keys are Docker container ids.
      stats:          statsMap[id] ?? null,
    };
  });

  // Parse compose stacks
  interface StackMeta { name: string; status: string; configFiles: string[] }
  const stackMeta: StackMeta[] = [];
  if (composeRes.ok) {
    try {
      const parsed = JSON.parse(composeRes.stdout);
      if (Array.isArray(parsed)) {
        for (const s of parsed as Array<Record<string, string>>) {
          stackMeta.push({
            name:        String(s.Name ?? ""),
            status:      String(s.Status ?? ""),
            configFiles: String(s.ConfigFiles ?? "").split(",").map((f) => f.trim()).filter(Boolean),
          });
        }
      }
    } catch { /* ignore */ }
  }

  // Group containers by compose project
  const byProject: Record<string, ContainerEntry[]> = {};
  const standalone: ContainerEntry[] = [];

  for (const c of allContainers) {
    if (c.composeProject) {
      (byProject[c.composeProject] ??= []).push(c);
    } else {
      standalone.push(c);
    }
  }

  // Merge stack metadata with containers
  // Include stacks from `compose ls` even if they have no containers right now
  const knownProjects = new Set(stackMeta.map((s) => s.name));
  // Also add projects seen in container labels that aren't in compose ls
  for (const proj of Object.keys(byProject)) {
    if (!knownProjects.has(proj)) {
      stackMeta.push({ name: proj, status: "unknown", configFiles: [] });
      knownProjects.add(proj);
    }
  }

  const stacks = stackMeta.map((s) => ({
    name:        s.name,
    status:      s.status,
    configFiles: s.configFiles,
    containers:  (byProject[s.name] ?? []).map(({ composeProject: _cp, ...rest }) => rest),
  }));

  const storage = await getStorageState();

  return {
    available: true,
    version,
    stacks,
    standalone: standalone.map(({ composeProject: _cp, ...rest }) => rest),
    diskUsage,
    storage,
  };
}

// ── Nginx ────────────────────────────────────────────────────────────────────

async function getNginxData() {
  const layer = await getNginxLayerStatus();

  const versionRes = await getNginxVersionCached();
  if (!versionRes.ok) {
    return { available: false, reason: (versionRes.stderr || "Nginx container unavailable").trim(), layer };
  }

  const activeRes = await getNginxActiveStatusCached();

  const versionLine = (versionRes.stderr || versionRes.stdout).trim();
  const version = versionLine.replace("nginx version: ", "");
  const active = activeRes.ok && ["active", "true"].includes(activeRes.stdout.trim());
  // `nginx -t` only ever runs as part of an actual config apply (writeNginxConfig) —
  // routine status here reads the persisted result of the last real apply instead of
  // re-validating on every poll.
  const configTest = layer.lastOperation
    ? { ok: layer.lastOperation.ok, output: layer.lastOperation.output }
    : { ok: false, output: "No nginx config has been applied yet." };

  return { available: true, version, active, configTest, layer };
}

// ── Exported snapshot for socket manager ─────────────────────────────────────
async function buildSystemSnapshot() {
  const [docker, nginx, certbot, version] = await Promise.allSettled([getDockerData(), getNginxData(), getCertbotStatus(), getAppVersion()]);
  return {
    docker: docker.status === "fulfilled" ? docker.value : { available: false, reason: String(docker.reason) },
    nginx:  nginx.status === "fulfilled"  ? nginx.value  : { available: false, reason: String(nginx.reason) },
    certbot: certbot.status === "fulfilled" ? certbot.value : { available: false, reason: String(certbot.reason), entries: [] },
    version: version.status === "fulfilled" ? version.value : null,
  };
}

export type SystemSnapshot = Awaited<ReturnType<typeof buildSystemSnapshot>>;

export function getSystemSnapshot(): Promise<SystemSnapshot> {
  return buildSystemSnapshot();
}
