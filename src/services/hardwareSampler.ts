import * as os from "os";
import { getDatabase } from "../config/database";

const SAMPLE_INTERVAL_MS = 15_000;
const RETENTION_DAYS = 7;

interface CpuSnapshot {
  idle: number;
  total: number;
}

function readCpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

class HardwareSampler {
  private timer: NodeJS.Timeout | null = null;
  private prev: CpuSnapshot | null = null;

  start(): void {
    if (this.timer) return;
    this.prev = readCpuSnapshot();
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  private sample(): void {
    const snapshot = readCpuSnapshot();
    const prev = this.prev;
    this.prev = snapshot;
    if (!prev) return; // first tick has no delta to compare against

    const idleDelta = snapshot.idle - prev.idle;
    const totalDelta = snapshot.total - prev.total;
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta))) : 0;

    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();

    const db = getDatabase();
    db.prepare(`
      INSERT INTO hardware_samples (cpu_percent, mem_percent, mem_used_mb, mem_total_mb, load1, sampled_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      cpuPercent,
      (memUsed / memTotal) * 100,
      memUsed / (1024 * 1024),
      memTotal / (1024 * 1024),
      os.loadavg()[0],
      new Date().toISOString()
    );

    db.prepare("DELETE FROM hardware_samples WHERE sampled_at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.prev = null;
  }
}

export const hardwareSampler = new HardwareSampler();
