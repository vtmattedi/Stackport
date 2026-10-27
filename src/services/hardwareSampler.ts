import * as os from "os";
import { getDatabase } from "../config/database";
import { getDockerRootFreeSpaceCached } from "./dockerStatusCache";
import { readNetworkTotals, type NetworkTotals } from "./hostInfo";

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

interface NetSnapshot {
  totals: NetworkTotals;
  at: number;
}

/** Bytes per second between two readings; null across a counter reset (reboot,
 *  interface replaced) or when the interface set changed. */
export function networkRates(prev: NetSnapshot | null, next: NetSnapshot): { rxBps: number; txBps: number } | null {
  if (!prev || prev.totals.interfaces.join() !== next.totals.interfaces.join()) return null;
  const seconds = (next.at - prev.at) / 1000;
  const rx = next.totals.rxBytes - prev.totals.rxBytes;
  const tx = next.totals.txBytes - prev.totals.txBytes;
  if (seconds <= 0 || rx < 0 || tx < 0) return null;
  return { rxBps: rx / seconds, txBps: tx / seconds };
}

class HardwareSampler {
  private timer: NodeJS.Timeout | null = null;
  private prev: CpuSnapshot | null = null;
  private prevNet: NetSnapshot | null = null;

  start(): void {
    if (this.timer) return;
    this.prev = readCpuSnapshot();
    void this.readNet();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
  }

  /** Reads the counters, returns the rate since the previous reading and keeps this one. */
  private async readNet(): Promise<{ rxBps: number; txBps: number } | null> {
    const totals = await readNetworkTotals();
    if (!totals) { this.prevNet = null; return null; }
    const next = { totals, at: Date.now() };
    const rates = networkRates(this.prevNet, next);
    this.prevNet = next;
    return rates;
  }

  private async sample(): Promise<void> {
    const snapshot = readCpuSnapshot();
    const prev = this.prev;
    this.prev = snapshot;
    if (!prev) return; // first tick has no delta to compare against

    const idleDelta = snapshot.idle - prev.idle;
    const totalDelta = snapshot.total - prev.total;
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta))) : 0;

    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    const net = await this.readNet().catch(() => null);
    const disk = await getDockerRootFreeSpaceCached().catch(() => null);
    const diskUsedPct = disk?.ok && disk.totalBytes && disk.freeBytes !== null
      ? 100 * (1 - disk.freeBytes / disk.totalBytes)
      : null;

    const db = getDatabase();
    db.prepare(`
      INSERT INTO hardware_samples (cpu_percent, mem_percent, mem_used_mb, mem_total_mb, load1, net_rx_bps, net_tx_bps, disk_used_pct, sampled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cpuPercent,
      (memUsed / memTotal) * 100,
      memUsed / (1024 * 1024),
      memTotal / (1024 * 1024),
      os.loadavg()[0],
      net?.rxBps ?? null,
      net?.txBps ?? null,
      diskUsedPct,
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
    this.prevNet = null;
  }
}

export const hardwareSampler = new HardwareSampler();
