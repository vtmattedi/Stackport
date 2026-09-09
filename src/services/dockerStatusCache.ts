import { execFile } from "child_process";
import { statfs } from "fs/promises";
import { pollingCadenceS } from "../config/pollingCadence";
import { SingleFlightCache } from "../utils/singleFlightCache";

export interface RunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  notFound: boolean;
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const notFound = !!(err && (err as NodeJS.ErrnoException).code === "ENOENT");
      resolve({ stdout, stderr, ok: !err, notFound });
    });
  });
}

// Shared, single-flighted, TTL'd caches around the handful of flat (non-per-project)
// docker CLI calls. Every consumer of docker status — the socket-pushed system
// snapshot, the REST fallback, and the independent project-resource sampler — reads
// through these instead of spawning its own subprocess, so concurrent/duplicate
// callers coalesce onto one real docker invocation per TTL window.
const dockerVersionCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["version", "--format", "{{json .}}"]),
  null, // startup / explicit refresh only
);
const containerListCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["ps", "-a", "--format", "{{json .}}"]),
  pollingCadenceS.containerState * 1000,
);
const containerStatsCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["stats", "--no-stream", "--format", "{{json .}}"]),
  pollingCadenceS.containerStats * 1000,
);
const composeStacksCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["compose", "ls", "--all", "--format", "json"]),
  pollingCadenceS.dockerComposeLs * 1000,
);
const diskUsageCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["system", "df", "--format", "json"]),
  pollingCadenceS.dockerDiskUsage * 1000,
);

export interface DiskFreeSpace {
  ok: boolean;
  dockerRoot: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
}

// `docker system df` (diskUsageCache above) reports Docker's own object accounting
// (images/containers/volumes/build-cache sizes), not free space on the filesystem
// that actually holds them — this is the host filesystem check that's missing today
// (Phase 1.4). Reads Docker's real data-root path first rather than assuming it's
// under deployRoot()/the app's own cwd, since the two can be on different
// filesystems (e.g. Docker's data-root moved to a separate volume).
async function fetchDockerRootFreeSpace(): Promise<DiskFreeSpace> {
  const info = await run("docker", ["info", "--format", "{{json .DockerRootDir}}"]);
  if (!info.ok) return { ok: false, dockerRoot: null, freeBytes: null, totalBytes: null };

  let dockerRoot: string;
  try {
    dockerRoot = JSON.parse(info.stdout.trim()) as string;
  } catch {
    return { ok: false, dockerRoot: null, freeBytes: null, totalBytes: null };
  }

  try {
    const stats = await statfs(dockerRoot);
    return {
      ok: true,
      dockerRoot,
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch {
    return { ok: false, dockerRoot, freeBytes: null, totalBytes: null };
  }
}

const dockerRootFreeSpaceCache = new SingleFlightCache<DiskFreeSpace>(
  fetchDockerRootFreeSpace,
  pollingCadenceS.dockerDiskUsage * 1000,
);

export const getDockerVersionCached = (): Promise<RunResult> => dockerVersionCache.get();
export const getContainerListCached = (): Promise<RunResult> => containerListCache.get();
export const getContainerStatsCached = (): Promise<RunResult> => containerStatsCache.get();
export const getComposeStacksCached = (): Promise<RunResult> => composeStacksCache.get();
export const getDiskUsageCached = (): Promise<RunResult> => diskUsageCache.get();
export const getDockerRootFreeSpaceCached = (): Promise<DiskFreeSpace> => dockerRootFreeSpaceCache.get();

/** Runs the same build-cache-only prune the manual System-page button uses
 *  (`docker builder prune -a -f` — fixed this session to no longer silently exclude
 *  cache younger than 7 days), shared with the Phase 1.4 pre-build guard and
 *  automatic cleanup monitor so there's exactly one place that invokes it. */
export async function pruneBuildCache(): Promise<RunResult> {
  const result = await run("docker", ["builder", "prune", "-a", "-f"], 300_000);
  invalidateDiskUsage();
  invalidateDockerRootFreeSpace();
  return result;
}

/** Deploy/build/compose/recreate/force-rebuild/stop/stop-purge finished (a real
 *  `docker compose up`/`down` ran) — the running container set and stack membership
 *  may have changed. */
export function invalidateContainers(): void {
  containerListCache.invalidate();
  containerStatsCache.invalidate();
  composeStacksCache.invalidate();
}

/** Docker build-cache prune finished. */
export function invalidateDiskUsage(): void {
  diskUsageCache.invalidate();
}

/** Docker build-cache prune finished — free space changed too. */
export function invalidateDockerRootFreeSpace(): void {
  dockerRootFreeSpaceCache.invalidate();
}

/** No in-app "install docker" flow currently calls this — kept for symmetry with the
 *  nginx/certbot version caches and any future docker-install action. */
export function invalidateDockerVersion(): void {
  dockerVersionCache.invalidate();
}
