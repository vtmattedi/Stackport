import { getDatabase } from "../config/database";
import { getDockerRootFreeSpaceCached, pruneBuildCache } from "./dockerStatusCache";

/** Phase 1.4 — pre-build disk-pressure guard and configurable automatic build-cache
 *  cleanup. Deliberately does not include "rollback image" protection: today's
 *  docker-compose.system.yml has no versioned image tag at all (a rebuild just
 *  overwrites the single `latest` tag in place), so there is no second image yet to
 *  protect — that only becomes meaningful once Phase 1.8 introduces real
 *  registry-pulled versioned images. */

const WARNING_FREE_BYTES_KEY = "docker_storage_warning_free_bytes";
const WARNING_FREE_PCT_KEY = "docker_storage_warning_free_pct";
const CRITICAL_FREE_BYTES_KEY = "docker_storage_critical_free_bytes";
const CRITICAL_FREE_PCT_KEY = "docker_storage_critical_free_pct";

const DEFAULT_WARNING_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_WARNING_FREE_PCT = 10;
const DEFAULT_CRITICAL_FREE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
const DEFAULT_CRITICAL_FREE_PCT = 5;

export interface StorageThresholds {
  warningFreeBytes: number;
  warningFreePct: number;
  criticalFreeBytes: number;
  criticalFreePct: number;
}

function readMetaNumber(key: string, fallback: number): number {
  const row = getDatabase().prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function writeMetaNumber(key: string, value: number): void {
  getDatabase()
    .prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, String(value));
}

export function getStorageThresholds(): StorageThresholds {
  return {
    warningFreeBytes: readMetaNumber(WARNING_FREE_BYTES_KEY, DEFAULT_WARNING_FREE_BYTES),
    warningFreePct: readMetaNumber(WARNING_FREE_PCT_KEY, DEFAULT_WARNING_FREE_PCT),
    criticalFreeBytes: readMetaNumber(CRITICAL_FREE_BYTES_KEY, DEFAULT_CRITICAL_FREE_BYTES),
    criticalFreePct: readMetaNumber(CRITICAL_FREE_PCT_KEY, DEFAULT_CRITICAL_FREE_PCT),
  };
}

export function setStorageThresholds(thresholds: StorageThresholds): void {
  writeMetaNumber(WARNING_FREE_BYTES_KEY, thresholds.warningFreeBytes);
  writeMetaNumber(WARNING_FREE_PCT_KEY, thresholds.warningFreePct);
  writeMetaNumber(CRITICAL_FREE_BYTES_KEY, thresholds.criticalFreeBytes);
  writeMetaNumber(CRITICAL_FREE_PCT_KEY, thresholds.criticalFreePct);
}

export type StorageState = "normal" | "warning" | "critical" | "unknown";

export interface StorageStatus {
  state: StorageState;
  freeBytes: number | null;
  totalBytes: number | null;
  freePct: number | null;
  thresholds: StorageThresholds;
}

/** A threshold trips on EITHER its absolute-bytes or percentage form, whichever is
 *  more conservative — a huge disk with 10% free can still be many GB, while a small
 *  disk at 10% free might already be critically low in absolute terms; checking both
 *  keeps this useful across small and large VPS disks (per the source doc). */
export async function getStorageState(): Promise<StorageStatus> {
  const thresholds = getStorageThresholds();
  const free = await getDockerRootFreeSpaceCached();
  if (!free.ok || free.freeBytes == null || free.totalBytes == null) {
    return { state: "unknown", freeBytes: null, totalBytes: null, freePct: null, thresholds };
  }

  const freePct = free.totalBytes > 0 ? (free.freeBytes / free.totalBytes) * 100 : 100;
  const critical = free.freeBytes < thresholds.criticalFreeBytes || freePct < thresholds.criticalFreePct;
  const warning = free.freeBytes < thresholds.warningFreeBytes || freePct < thresholds.warningFreePct;

  return {
    state: critical ? "critical" : warning ? "warning" : "normal",
    freeBytes: free.freeBytes,
    totalBytes: free.totalBytes,
    freePct,
    thresholds,
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

/** Called right before a build-invoking compose command. Only intervenes at
 *  `critical` — `warning` is handled by the separate, less time-sensitive automatic
 *  cleanup monitor (dockerStorageMonitor.ts) rather than adding latency/surprise
 *  cache eviction to every single build. Never touches project volumes — only the
 *  same build-cache-only prune the manual button already uses. */
export async function ensureBuildCapacity(): Promise<{ ok: boolean; message: string }> {
  const before = await getStorageState();
  if (before.state !== "critical") return { ok: true, message: "" };

  const pruneMessage = `Low disk space (${formatBytes(before.freeBytes)} free) — clearing Docker build cache before continuing.\n`;
  await pruneBuildCache();
  const after = await getStorageState();

  if (after.state === "critical") {
    return {
      ok: false,
      message:
        `Deployment blocked — insufficient disk space (${formatBytes(after.freeBytes)} free) even after clearing the ` +
        `Docker build cache. Free up space on the host before retrying.\n`,
    };
  }
  return { ok: true, message: `${pruneMessage}Freed up space: ${formatBytes(before.freeBytes)} -> ${formatBytes(after.freeBytes)} free.\n` };
}
