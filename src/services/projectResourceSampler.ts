import { execFile } from "child_process";
import { getDatabase } from "../config/database";
import { expectedComposeProjectName, projectRepoDir } from "./projectDeploy";
import { getContainerListCached, getContainerStatsCached } from "./dockerStatusCache";
import { emitProjectResourceSample } from "./realtime";

const SAMPLE_INTERVAL_MS = 15_000;
const RETENTION_DAYS = 7;
// Folder sizes (`du -sb`) are slow relative to `docker stats` — sample them far
// less often than cpu/mem/net, on every Nth tick of the same interval instead of
// a second timer.
const FOLDER_SIZE_EVERY_N_TICKS = 20; // ~5 minutes at the 15s sample interval

function parseNdjson(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; }
      catch { return []; }
    });
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const kv of s.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

// "12.34MiB" / "1.95GiB" / "512kB" -> megabytes
function parseSizeToMb(raw: string): number {
  const match = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1 / (1024 * 1024),
    kb: 1 / 1024,
    kib: 1 / 1024,
    mb: 1,
    mib: 1,
    gb: 1024,
    gib: 1024,
    tb: 1024 * 1024,
    tib: 1024 * 1024,
  };
  return value * (multipliers[unit] ?? 1);
}

interface StackUsage {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
  // Cumulative since each container's start (as reported by `docker stats`),
  // summed across containers in the stack — not a rate. Callers must diff
  // against a previous sample to get a meaningful per-interval value.
  netRxMb: number;
  netTxMb: number;
}

// Reads through the same shared, single-flighted caches the system-status endpoint
// uses (dockerStatusCache.ts) rather than spawning its own `docker ps`/`docker
// stats` — this sampler runs on its own always-on 15s timer, independent of whether
// anyone has the System page open, so without sharing the cache it would double
// every docker CLI spawn the status endpoint already makes.
async function readStackUsage(): Promise<Map<string, StackUsage>> {
  const [psRes, statsRes] = await Promise.all([
    getContainerListCached(),
    getContainerStatsCached(),
  ]);
  if (!psRes.ok || !statsRes.ok) return new Map();

  const composeProjectById = new Map<string, string>();
  for (const c of parseNdjson(psRes.stdout)) {
    const id = String(c.ID ?? "").slice(0, 12);
    const labels = parseLabels(String(c.Labels ?? ""));
    const composeProject = labels["com.docker.compose.project"];
    if (id && composeProject) composeProjectById.set(id, composeProject);
  }

  const byStack = new Map<string, StackUsage>();
  for (const s of parseNdjson(statsRes.stdout)) {
    const id = String(s.ID ?? "").slice(0, 12);
    const composeProject = composeProjectById.get(id);
    if (!composeProject) continue;

    const cpuPercent = Number(String(s.CPUPerc ?? "0").replace("%", "")) || 0;
    const [usedRaw, limitRaw] = String(s.MemUsage ?? "0 / 0").split("/").map((part) => part.trim());
    const memUsedMb = parseSizeToMb(usedRaw ?? "0");
    const memLimitMb = parseSizeToMb(limitRaw ?? "0");
    const [rxRaw, txRaw] = String(s.NetIO ?? "0 / 0").split("/").map((part) => part.trim());
    const netRxMb = parseSizeToMb(rxRaw ?? "0");
    const netTxMb = parseSizeToMb(txRaw ?? "0");

    const existing = byStack.get(composeProject) ?? { cpuPercent: 0, memUsedMb: 0, memLimitMb: 0, netRxMb: 0, netTxMb: 0 };
    byStack.set(composeProject, {
      cpuPercent: existing.cpuPercent + cpuPercent,
      memUsedMb: existing.memUsedMb + memUsedMb,
      memLimitMb: existing.memLimitMb + memLimitMb,
      netRxMb: existing.netRxMb + netRxMb,
      netTxMb: existing.netTxMb + netTxMb,
    });
  }

  return byStack;
}

function measureFolderSizeBytes(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("du", ["-sb", dir], { timeout: 30_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const match = /^(\d+)/.exec(stdout.trim());
      resolve(match ? Number(match[1]) : null);
    });
  });
}

class ProjectResourceSampler {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private tickCount = 0;
  // Cumulative net rx/tx bytes (as last reported by `docker stats`) per compose
  // stack, used to turn the cumulative counter into a per-tick delta. Reset
  // implicitly whenever a container restarts (the raw counter drops, the next
  // delta is clamped to 0 rather than going negative).
  private prevNet = new Map<string, { rxMb: number; txMb: number }>();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
  }

  private async sample(): Promise<void> {
    if (this.sampling) return; // a prior docker stats call is still running
    this.sampling = true;
    try {
      await this.sampleDockerUsage();
      this.tickCount += 1;
      if (this.tickCount % FOLDER_SIZE_EVERY_N_TICKS === 0) {
        await this.sampleFolderSizes();
      }
    } finally {
      this.sampling = false;
    }
  }

  private async sampleDockerUsage(): Promise<void> {
    try {
      const usageByStack = await readStackUsage();
      if (usageByStack.size === 0) return;

      const projects = getDatabase().prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[];
      const sampledAt = new Date().toISOString();
      const db = getDatabase();
      const insert = db.prepare(`
        INSERT INTO project_resource_samples (project_id, cpu_percent, mem_used_mb, mem_limit_mb, mem_percent, net_rx_mb, net_tx_mb, sampled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const project of projects) {
        const stackName = expectedComposeProjectName(project);
        const usage = usageByStack.get(stackName);
        if (!usage) continue;
        const memPercent = usage.memLimitMb > 0 ? Math.min(100, (usage.memUsedMb / usage.memLimitMb) * 100) : 0;

        const prev = this.prevNet.get(stackName);
        const netRxDeltaMb = prev ? Math.max(0, usage.netRxMb - prev.rxMb) : 0;
        const netTxDeltaMb = prev ? Math.max(0, usage.netTxMb - prev.txMb) : 0;
        this.prevNet.set(stackName, { rxMb: usage.netRxMb, txMb: usage.netTxMb });

        insert.run(project.id, usage.cpuPercent, usage.memUsedMb, usage.memLimitMb, memPercent, netRxDeltaMb, netTxDeltaMb, sampledAt);
        emitProjectResourceSample({
          projectId: project.id,
          sample: {
            cpuPercent: usage.cpuPercent,
            memUsedMb: usage.memUsedMb,
            memLimitMb: usage.memLimitMb,
            memPercent,
            netRxMb: netRxDeltaMb,
            netTxMb: netTxDeltaMb,
            sampledAt,
          },
        });
      }

      db.prepare("DELETE FROM project_resource_samples WHERE sampled_at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`);
    } catch {
      // docker may be temporarily unavailable — skip this tick
    }
  }

  private async sampleFolderSizes(): Promise<void> {
    try {
      const db = getDatabase();
      const projects = db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[];
      const sampledAt = new Date().toISOString();

      const results = await Promise.allSettled(projects.map(async (project) => ({
        projectId: project.id,
        size: await measureFolderSizeBytes(projectRepoDir(project)),
      })));

      const insert = db.prepare(`
        INSERT INTO project_folder_size_samples (project_id, size_bytes, sampled_at)
        VALUES (?, ?, ?)
      `);
      for (const result of results) {
        if (result.status !== "fulfilled" || result.value.size === null) continue;
        insert.run(result.value.projectId, result.value.size, sampledAt);
      }

      db.prepare("DELETE FROM project_folder_size_samples WHERE sampled_at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`);
    } catch {
      // a project's deploy directory may be mid-swap (manual upload) or missing — skip this tick
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.prevNet.clear();
    this.tickCount = 0;
  }
}

export const projectResourceSampler = new ProjectResourceSampler();
