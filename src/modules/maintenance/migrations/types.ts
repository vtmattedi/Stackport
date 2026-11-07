/**
 * TEMPORARY: one-off data migrations an admin runs from Settings > Migrations.
 *
 * To remove this feature once every install has run its migrations:
 *   1. delete this folder (src/modules/maintenance/migrations) and client/src/pages/settings/migrations
 *   2. delete the `legacyMigrationsRouter` lines in src/application/http/routes.ts
 *   3. delete the "migrations" entries in client/src/pages/settings/SettingsLayout.tsx
 *      and the route in client/src/App.tsx
 *   4. delete tests/legacyMigrations*.test.ts
 * Nothing else imports from here.
 */

export type ReportStatus = "ok" | "warn" | "error" | "info";

export interface ReportItem {
  status: ReportStatus;
  label: string;
  detail?: string;
}

export interface MigrationReport {
  summary: string;
  items: ReportItem[];
}

export type MigrationMode = "dry-run" | "execute";

export interface LegacyMigration {
  id: string;
  title: string;
  description: string;
  /** Shown in the confirmation before an execute. */
  executeWarning: string;
  /** The execute deletes data: the confirmation says so. */
  destructive?: boolean;
  /** One code path for both modes, so a dry run reports exactly what an execute would do.
   *  In "dry-run" it must change nothing. */
  run(mode: MigrationMode): Promise<MigrationReport>;
}

export interface MigrationJob {
  state: "idle" | "running" | "done" | "failed";
  mode: MigrationMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  report: MigrationReport | null;
  error: string | null;
}
