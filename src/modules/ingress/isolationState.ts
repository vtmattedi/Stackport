import { getDatabase } from "../../config/database";

/** Whether a project's routed services are on a network of their own (P7). Kept apart from the Docker
 *  work in isolation.ts so the nginx writer and the Compose rewrite can ask without importing it. */
export function isIngressIsolated(projectId: number): boolean {
  const row = getDatabase().prepare("SELECT ingress_isolated AS isolated FROM projects WHERE id = ?").get(projectId) as { isolated: number } | undefined;
  return row?.isolated === 1;
}

export function setIngressIsolated(projectId: number, isolated: boolean): boolean {
  return getDatabase().prepare("UPDATE projects SET ingress_isolated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isolated ? 1 : 0, projectId).changes > 0;
}

export function listIsolatedProjectIds(): number[] {
  return (getDatabase().prepare("SELECT id FROM projects WHERE ingress_isolated = 1 ORDER BY id").all() as { id: number }[]).map((row) => row.id);
}
