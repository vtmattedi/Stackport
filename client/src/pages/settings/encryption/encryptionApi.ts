/** The Settings > Encryption page keeps its own API calls: nothing else in the client uses them. */
import { ApiError, sessionHeaders } from "../../../api/client";

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

export interface MigrationInfo { id: string; title: string; description: string; executeWarning: string; destructive: boolean; job: MigrationJob }

async function call<T>(path: string, method: "GET" | "POST"): Promise<T> {
  const res = await fetch(`/api/encryption${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...sessionHeaders() },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Request failed" }))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "Request failed");
  }
  return (await res.json()) as T;
}

export const encryptionApi = {
  list: () => call<MigrationInfo[]>("", "GET"),
  start: (id: string, mode: MigrationMode) => call<MigrationJob>(`/${id}/${mode}`, "POST"),
};
