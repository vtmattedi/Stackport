import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { logger } from "../../shared/logger";
import { deleteProjectActionLogs } from "../actions/log";
import { disableWebhook } from "../automation/githubWebhooks";
import { healthChecker } from "../deployments/health";
import { leaveNetworkGroup } from "../deployments/operations";
import { removeIngressNetwork } from "../ingress/networks";
import { removeIsolatedNetworkQuietly } from "../ingress/isolation";
import { removeProjectTcpRuntime } from "../ingress/tcp";
import type { ProjectRow } from "./types";

export type DestroyOutcome = { ok: true } | { ok: false; error: string };

/** Removes a project's record and everything Stackport runs on its behalf (TCP proxies, webhook, networks, action logs). It does not stop containers or remove
 *  volumes: that is `stopAndPurgeProject`, which a caller that wants the data gone runs first. The delete route and a committed move both end here. */
export async function destroyProject(id: number, db: Database.Database = getDatabase()): Promise<DestroyOutcome> {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) return { ok: false, error: "Project not found" };

  await leaveNetworkGroup({ id, name: row.name }).catch(() => undefined);
  try {
    await removeProjectTcpRuntime(id);
  } catch (err) {
    return { ok: false, error: `Could not remove project TCP proxies: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (row.github_hook_id != null) {
    const warning = await disableWebhook(id);
    if (warning) logger.warn({ project: row.name, warning }, "webhook");
  }
  // Action rows go with the project (ON DELETE CASCADE); their log files don't.
  deleteProjectActionLogs(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  healthChecker.unschedule(id);
  void removeIngressNetwork(id);
  void removeIsolatedNetworkQuietly(id);
  return { ok: true };
}
