/**
 * TEMPORARY: the whole Settings > Migrations page lives in this folder, with its own
 * API calls so nothing else in the client depends on it. To remove it, see
 * src/legacyMigrations/types.ts on the server.
 */
import { ApiError, getToken } from "../../../api/client";

export type ReportStatus = "ok" | "warn" | "error" | "info";
export interface ReportItem { status: ReportStatus; label: string; detail?: string }
export interface MigrationReport { summary: string; items: ReportItem[] }
export type MigrationMode = "dry-run" | "execute";

export interface MigrationJob {
  state: "idle" | "running" | "done" | "failed";
  mode: MigrationMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  report: MigrationReport | null;
  error: string | null;
}

export interface MigrationInfo { id: string; title: string; description: string; job: MigrationJob }

async function call<T>(path: string, method: "GET" | "POST"): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/legacy-migrations${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Request failed" }))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "Request failed");
  }
  return (await res.json()) as T;
}

export const migrationsApi = {
  list: () => call<MigrationInfo[]>("", "GET"),
  start: (id: string, mode: MigrationMode) => call<MigrationJob>(`/${id}/${mode}`, "POST"),
};
