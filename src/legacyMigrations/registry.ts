import { logger } from "../utils/logger";
import type { LegacyMigration, MigrationJob, MigrationMode } from "./types";
import { cleanupMountsMigration } from "./cleanupMounts";
import { volumeMountsMigration } from "./volumeMounts";

/** Add a migration here. Order is the order shown on the page. */
export const LEGACY_MIGRATIONS: LegacyMigration[] = [volumeMountsMigration, cleanupMountsMigration];

const idle = (): MigrationJob => ({ state: "idle", mode: null, startedAt: null, finishedAt: null, report: null, error: null });
const jobs = new Map<string, MigrationJob>();

export function getJob(id: string): MigrationJob {
  return jobs.get(id) ?? idle();
}

export function findMigration(id: string): LegacyMigration | undefined {
  return LEGACY_MIGRATIONS.find((migration) => migration.id === id);
}

/** Starts a run in the background; false when this migration is already running. The
 *  result is kept in memory for the page to read: a restart clears it, which is fine for
 *  a report an admin reads once. */
export function startJob(migration: LegacyMigration, mode: MigrationMode): boolean {
  if (getJob(migration.id).state === "running") return false;
  const job: MigrationJob = { ...idle(), state: "running", mode, startedAt: new Date().toISOString() };
  jobs.set(migration.id, job);
  void migration.run(mode).then(
    (report) => { jobs.set(migration.id, { ...job, state: "done", finishedAt: new Date().toISOString(), report }); },
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ migration: migration.id, mode, error }, "legacy-migration.failed");
      jobs.set(migration.id, { ...job, state: "failed", finishedAt: new Date().toISOString(), error });
    },
  );
  return true;
}
