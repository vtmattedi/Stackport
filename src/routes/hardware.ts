import { Router, Request, Response } from "express";
import * as os from "os";
import { requireAuth } from "../middleware/auth";
import { getDatabase } from "../config/database";

const router = Router();
router.use(requireAuth);

interface SampleRow {
  cpu_percent: number;
  mem_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  load1: number;
  sampled_at: string;
}

interface BucketRow {
  bucket: string;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
  load1_avg: number;
}

function rowToSample(r: SampleRow) {
  return {
    cpuPercent: r.cpu_percent,
    memPercent: r.mem_percent,
    memUsedMb: r.mem_used_mb,
    memTotalMb: r.mem_total_mb,
    load1: r.load1,
    sampledAt: r.sampled_at,
  };
}

const MIN_HOURS = 1;
const MAX_HOURS = 168; // 7 days, matches sampler retention

function clampHours(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 24;
  return Math.min(Math.max(n, MIN_HOURS), MAX_HOURS);
}

export function getHardwareSnapshot(hours = 24) {
  const db = getDatabase();
  const clamped = clampHours(hours);

  const latest = db.prepare("SELECT * FROM hardware_samples ORDER BY sampled_at DESC LIMIT 1").get() as SampleRow | undefined;

  const history = db.prepare(`
    SELECT
      datetime((strftime('%s', sampled_at) / 300) * 300, 'unixepoch') AS bucket,
      AVG(cpu_percent) AS cpu_avg,
      MAX(cpu_percent) AS cpu_max,
      AVG(mem_percent) AS mem_avg,
      MAX(mem_percent) AS mem_max,
      AVG(load1) AS load1_avg
    FROM hardware_samples
    WHERE sampled_at >= datetime('now', ?)
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(`-${clamped} hours`) as BucketRow[];

  return {
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    latest: latest ? rowToSample(latest) : null,
    history: history.map((h) => ({
      ts: h.bucket,
      cpuAvg: h.cpu_avg,
      cpuMax: h.cpu_max,
      memAvg: h.mem_avg,
      memMax: h.mem_max,
      load1: h.load1_avg,
    })),
  };
}

// GET /api/hardware?hours=24 — latest sample plus 5-minute bucketed history
router.get("/", (req: Request, res: Response): void => {
  res.json(getHardwareSnapshot(clampHours(req.query.hours)));
});

export default router;
