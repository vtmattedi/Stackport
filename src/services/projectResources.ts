import { getDatabase } from "../config/database";

interface SampleRow {
  cpu_percent: number;
  mem_used_mb: number;
  mem_limit_mb: number;
  mem_percent: number;
  net_rx_mb: number | null;
  net_tx_mb: number | null;
  sampled_at: string;
}

interface BucketRow {
  bucket: string;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
  mem_used_avg: number;
  net_rx_sum: number | null;
  net_tx_sum: number | null;
}

interface FolderSizeRow {
  size_bytes: number;
  sampled_at: string;
}

const MIN_HOURS = 1;
const MAX_HOURS = 168; // 7 days, matches sampler retention

function clampHours(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 24;
  return Math.min(Math.max(n, MIN_HOURS), MAX_HOURS);
}

function rowToSample(r: SampleRow) {
  return {
    cpuPercent: r.cpu_percent,
    memUsedMb: r.mem_used_mb,
    memLimitMb: r.mem_limit_mb,
    memPercent: r.mem_percent,
    netRxMb: r.net_rx_mb ?? 0,
    netTxMb: r.net_tx_mb ?? 0,
    sampledAt: r.sampled_at,
  };
}

// Latest sample plus 5-minute bucketed history for a single project's docker compose stack,
// plus its deploy-directory disk size (sampled far less often — see projectResourceSampler.ts).
export function getProjectResourceSnapshot(projectId: number, hours = 24) {
  const db = getDatabase();
  const clamped = clampHours(hours);

  const latest = db
    .prepare("SELECT * FROM project_resource_samples WHERE project_id = ? ORDER BY sampled_at DESC LIMIT 1")
    .get(projectId) as SampleRow | undefined;

  const history = db.prepare(`
    SELECT
      datetime((strftime('%s', sampled_at) / 300) * 300, 'unixepoch') AS bucket,
      AVG(cpu_percent) AS cpu_avg,
      MAX(cpu_percent) AS cpu_max,
      AVG(mem_percent) AS mem_avg,
      MAX(mem_percent) AS mem_max,
      AVG(mem_used_mb) AS mem_used_avg,
      SUM(net_rx_mb) AS net_rx_sum,
      SUM(net_tx_mb) AS net_tx_sum
    FROM project_resource_samples
    WHERE project_id = ? AND sampled_at >= datetime('now', ?)
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(projectId, `-${clamped} hours`) as BucketRow[];

  const latestFolderSize = db
    .prepare("SELECT * FROM project_folder_size_samples WHERE project_id = ? ORDER BY sampled_at DESC LIMIT 1")
    .get(projectId) as FolderSizeRow | undefined;

  const folderSizeHistory = db.prepare(`
    SELECT size_bytes, sampled_at FROM project_folder_size_samples
    WHERE project_id = ? AND sampled_at >= datetime('now', ?)
    ORDER BY sampled_at ASC
  `).all(projectId, `-${clamped} hours`) as FolderSizeRow[];

  return {
    latest: latest ? rowToSample(latest) : null,
    history: history.map((h) => ({
      ts: h.bucket,
      cpuAvg: h.cpu_avg,
      cpuMax: h.cpu_max,
      memAvg: h.mem_avg,
      memMax: h.mem_max,
      memUsedMb: h.mem_used_avg,
      netRxMb: h.net_rx_sum ?? 0,
      netTxMb: h.net_tx_sum ?? 0,
    })),
    diskSize: {
      latest: latestFolderSize ? { sizeBytes: latestFolderSize.size_bytes, sampledAt: latestFolderSize.sampled_at } : null,
      history: folderSizeHistory.map((h) => ({ ts: h.sampled_at, sizeBytes: h.size_bytes })),
    },
  };
}

export interface ProjectResourceSummaryItem {
  projectId: number;
  name: string;
  cpuPercent: number;
  memUsedMb: number;
  memPercent: number;
  netRxMb: number;
  netTxMb: number;
  diskSizeMb: number | null;
  sampledAt: string | null;
}

// Latest cpu/mem gauge, summed net I/O over the window, and latest disk size — one row per
// project — for the Metrics page's per-project usage pie chart + table.
export function getProjectResourcesSummary(hours = 24): ProjectResourceSummaryItem[] {
  const db = getDatabase();
  const clamped = clampHours(hours);
  const projects = db.prepare("SELECT id, name FROM projects ORDER BY name ASC").all() as { id: number; name: string }[];

  const latestStmt = db.prepare(
    "SELECT cpu_percent, mem_used_mb, mem_percent, sampled_at FROM project_resource_samples WHERE project_id = ? ORDER BY sampled_at DESC LIMIT 1"
  );
  const netSumStmt = db.prepare(
    "SELECT COALESCE(SUM(net_rx_mb), 0) AS net_rx_sum, COALESCE(SUM(net_tx_mb), 0) AS net_tx_sum FROM project_resource_samples WHERE project_id = ? AND sampled_at >= datetime('now', ?)"
  );
  const diskStmt = db.prepare(
    "SELECT size_bytes FROM project_folder_size_samples WHERE project_id = ? ORDER BY sampled_at DESC LIMIT 1"
  );

  return projects.map((project) => {
    const latest = latestStmt.get(project.id) as Pick<SampleRow, "cpu_percent" | "mem_used_mb" | "mem_percent" | "sampled_at"> | undefined;
    const netSum = netSumStmt.get(project.id, `-${clamped} hours`) as { net_rx_sum: number; net_tx_sum: number };
    const disk = diskStmt.get(project.id) as { size_bytes: number } | undefined;

    return {
      projectId: project.id,
      name: project.name,
      cpuPercent: latest?.cpu_percent ?? 0,
      memUsedMb: latest?.mem_used_mb ?? 0,
      memPercent: latest?.mem_percent ?? 0,
      netRxMb: netSum.net_rx_sum,
      netTxMb: netSum.net_tx_sum,
      diskSizeMb: disk ? disk.size_bytes / (1024 * 1024) : null,
      sampledAt: latest?.sampled_at ?? null,
    };
  });
}

export type ResourceMetric = "cpu" | "mem" | "net" | "disk";
export type ResourceGranularity = "5m" | "day";

export interface ProjectResourceTimeseriesSeries {
  projectId: number;
  name: string;
  values: (number | null)[];
}

export interface ProjectResourcesTimeseries {
  buckets: string[];
  granularity: ResourceGranularity;
  series: ProjectResourceTimeseriesSeries[];
}

const BUCKET_SECONDS = 300;
const DAY_SECONDS = 86400;

// More than a day in view is too many 5-minute points to read as a chart —
// switch to one bucket per calendar day instead.
function resolveGranularity(hours: number): ResourceGranularity {
  return hours > 24 ? "day" : "5m";
}

function bucketDurationSeconds(granularity: ResourceGranularity): number {
  return granularity === "day" ? DAY_SECONDS : BUCKET_SECONDS;
}

// Buckets are generated arithmetically (not derived from sample rows) so every
// project's series is aligned to the exact same grid by construction, even
// when a project has gaps or no samples at all in some buckets.
function bucketGrid(hours: number, granularity: ResourceGranularity): number[] {
  const step = bucketDurationSeconds(granularity);
  const nowSec = Math.floor(Date.now() / 1000);
  const alignedNow = nowSec - (nowSec % step);
  const count = Math.ceil((hours * 3600) / step);
  const buckets: number[] = [];
  for (let i = count - 1; i >= 0; i--) buckets.push(alignedNow - i * step);
  return buckets;
}

// Matches SQLite's `datetime(x, 'unixepoch')` (5m) / `date(x)` (day) output format.
function bucketKey(epochSeconds: number, granularity: ResourceGranularity): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return granularity === "day" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

function resolveTimeseriesProjects(projectIds: number[] | null): { id: number; name: string }[] {
  const db = getDatabase();
  if (!projectIds || projectIds.length === 0) {
    return db.prepare("SELECT id, name FROM projects ORDER BY name ASC").all() as { id: number; name: string }[];
  }
  const placeholders = projectIds.map(() => "?").join(",");
  return db.prepare(`SELECT id, name FROM projects WHERE id IN (${placeholders}) ORDER BY name ASC`).all(...projectIds) as { id: number; name: string }[];
}

// Per-project bucketed series for the Metrics page's stacked area chart. cpu/mem/net
// bucket at 5-minute resolution up to a day, or one bucket per day beyond that (see
// resolveGranularity); disk (sampled far less often — see projectResourceSampler.ts)
// is forward-filled onto the same grid so all four metrics can be plotted the same way.
export function getProjectResourcesTimeseries(
  projectIds: number[] | null,
  hours: number,
  metric: ResourceMetric
): ProjectResourcesTimeseries {
  const db = getDatabase();
  const clamped = clampHours(hours);
  const granularity = resolveGranularity(clamped);
  const step = bucketDurationSeconds(granularity);
  const buckets = bucketGrid(clamped, granularity);
  const bucketKeys = buckets.map((b) => bucketKey(b, granularity));
  const windowArg = `-${clamped} hours`;
  const projects = resolveTimeseriesProjects(projectIds);

  if (metric === "disk") {
    const historyStmt = db.prepare(
      "SELECT size_bytes, sampled_at FROM project_folder_size_samples WHERE project_id = ? AND sampled_at >= datetime('now', ?) ORDER BY sampled_at ASC"
    );
    const seedStmt = db.prepare(
      "SELECT size_bytes FROM project_folder_size_samples WHERE project_id = ? AND sampled_at < datetime('now', ?) ORDER BY sampled_at DESC LIMIT 1"
    );

    const series = projects.map((project) => {
      const values = new Array<number | null>(buckets.length).fill(null);
      const seed = seedStmt.get(project.id, windowArg) as { size_bytes: number } | undefined;
      let carry = seed ? seed.size_bytes / (1024 * 1024) : null;
      const rows = historyStmt.all(project.id, windowArg) as { size_bytes: number; sampled_at: string }[];
      let rowIndex = 0;
      // A sample belongs to bucket i if it falls anywhere within [bucketStart, bucketStart + step) —
      // comparing against the bucket's end (not its start) avoids carrying same-bucket samples
      // forward into the *next* bucket instead.
      for (let i = 0; i < buckets.length; i++) {
        const bucketEnd = buckets[i] + step;
        while (
          rowIndex < rows.length &&
          Date.parse(`${rows[rowIndex].sampled_at.replace(" ", "T")}Z`) / 1000 < bucketEnd
        ) {
          carry = rows[rowIndex].size_bytes / (1024 * 1024);
          rowIndex++;
        }
        values[i] = carry;
      }
      return { projectId: project.id, name: project.name, values };
    });

    return { buckets: bucketKeys, granularity, series };
  }

  const columnExpr = metric === "cpu"
    ? "AVG(cpu_percent)"
    : metric === "mem"
      ? "AVG(mem_used_mb)"
      : "SUM(COALESCE(net_rx_mb, 0) + COALESCE(net_tx_mb, 0))";

  const bucketExpr = granularity === "day"
    ? "date(sampled_at)"
    : "datetime((strftime('%s', sampled_at) / 300) * 300, 'unixepoch')";

  const historyStmt = db.prepare(`
    SELECT
      ${bucketExpr} AS bucket,
      ${columnExpr} AS value
    FROM project_resource_samples
    WHERE project_id = ? AND sampled_at >= datetime('now', ?)
    GROUP BY bucket
    ORDER BY bucket ASC
  `);

  const bucketIndex = new Map(bucketKeys.map((key, i) => [key, i]));
  const series = projects.map((project) => {
    const values = new Array<number | null>(buckets.length).fill(null);
    const rows = historyStmt.all(project.id, windowArg) as { bucket: string; value: number }[];
    for (const row of rows) {
      const idx = bucketIndex.get(row.bucket);
      if (idx !== undefined) values[idx] = row.value;
    }
    return { projectId: project.id, name: project.name, values };
  });

  return { buckets: bucketKeys, granularity, series };
}

export { clampHours };
