/**
 * Tasks an admin runs from Settings > Encryption, each with a dry run and an execute. Today there is one, re-encrypting the stored
 * secrets, which is how an encryption key (or JWT_SECRET) is rotated. The one-off data migrations that lived here before 1.3.9
 * (managed volumes, removing the original mounts, encrypting env values) are gone.
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

export interface EncryptionTask {
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
