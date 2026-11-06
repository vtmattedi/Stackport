import { getDatabase } from "../config/database";
import { dumpYamlDoc } from "./composeYaml";

/**
 * Hardened defaults for managed services (S8).
 *
 * Every service of a project with hardened defaults on gets `no-new-privileges`, and a
 * memory limit and a process limit when the Compose file sets none. The limits are
 * defaults, not caps: a service that declares its own keeps it. They are applied
 * through a generated Compose override, like the managed mounts, so the project's file
 * is never edited. Capabilities are left at Docker's defaults (S1 already refuses the
 * dangerous additions).
 */

export interface HardeningDefaults {
  /** Process limit per service, as `pids_limit`. 0 means no default. */
  pidsLimit: number;
  /** Memory limit per service in megabytes, as `mem_limit`. 0 means no default. */
  memoryMb: number;
}

export const DEFAULT_HARDENING: HardeningDefaults = { pidsLimit: 512, memoryMb: 1024 };

const PIDS_KEY = "hardening_pids_limit";
const MEMORY_KEY = "hardening_memory_mb";

function readNumber(key: string, fallback: number): number {
  const row = getDatabase().prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function writeNumber(key: string, value: number): void {
  getDatabase()
    .prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, String(value));
}

export function getHardeningDefaults(): HardeningDefaults {
  return { pidsLimit: readNumber(PIDS_KEY, DEFAULT_HARDENING.pidsLimit), memoryMb: readNumber(MEMORY_KEY, DEFAULT_HARDENING.memoryMb) };
}

/** Throws a message for the first invalid field. */
export function setHardeningDefaults(values: unknown): HardeningDefaults {
  const input = (values ?? {}) as Partial<Record<keyof HardeningDefaults, unknown>>;
  for (const [key, max] of [["pidsLimit", 4_194_304], ["memoryMb", 16_777_216]] as const) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
      throw new Error(`${key} must be a whole number between 0 and ${max} (0 turns the default off)`);
    }
  }
  const next = input as HardeningDefaults;
  writeNumber(PIDS_KEY, next.pidsLimit);
  writeNumber(MEMORY_KEY, next.memoryMb);
  return getHardeningDefaults();
}

export function isHardeningEnabled(projectId: number): boolean {
  const row = getDatabase().prepare("SELECT hardened_defaults AS enabled FROM projects WHERE id = ?").get(projectId) as { enabled: number } | undefined;
  return row?.enabled !== 0;
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);

/** Whether the service already limits memory, in either of Compose's two spellings. */
function hasMemoryLimit(service: Json): boolean {
  const limits = asRecord(asRecord(asRecord(service["deploy"])?.["resources"])?.["limits"]);
  return service["mem_limit"] !== undefined || limits?.["memory"] !== undefined;
}

function hasPidsLimit(service: Json): boolean {
  const limits = asRecord(asRecord(asRecord(service["deploy"])?.["resources"])?.["limits"]);
  return service["pids_limit"] !== undefined || limits?.["pids"] !== undefined;
}

/** The override that adds the defaults to each service of a resolved config. Returns
 *  null when there are no services. Compose appends `security_opt` entries to the file's
 *  own, so the project's other options (which S1 limits) are kept. */
export function buildHardeningOverride(resolved: unknown, defaults: HardeningDefaults): string | null {
  const services = asRecord(asRecord(resolved)?.["services"]);
  const override: Record<string, Json> = {};
  for (const [name, value] of Object.entries(services ?? {})) {
    const service = asRecord(value);
    if (!service) continue;
    const entry: Json = { security_opt: ["no-new-privileges:true"] };
    if (defaults.memoryMb > 0 && !hasMemoryLimit(service)) entry["mem_limit"] = `${defaults.memoryMb}m`;
    if (defaults.pidsLimit > 0 && !hasPidsLimit(service)) entry["pids_limit"] = defaults.pidsLimit;
    override[name] = entry;
  }
  return Object.keys(override).length ? dumpYamlDoc({ services: override }) : null;
}
