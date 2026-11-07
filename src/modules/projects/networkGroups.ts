import { getDatabase } from "../../config/database";

/** Network group membership (see shared/networkGroups.ts): which group a project is in and which
 *  of its services join the group's network. Docker is touched elsewhere (deployments/). */

export interface NetworkGroupMembership { group: string | null; services: string[] }

export interface NetworkGroupPeer { projectId: number; name: string; services: string[] }

export function getNetworkGroup(projectId: number): NetworkGroupMembership {
  const db = getDatabase();
  const row = db.prepare("SELECT network_group AS grp FROM projects WHERE id = ?").get(projectId) as { grp: string | null } | undefined;
  if (!row?.grp) return { group: null, services: [] };
  const services = (db.prepare("SELECT service FROM network_group_services WHERE project_id = ? ORDER BY service").all(projectId) as { service: string }[]).map((r) => r.service);
  return { group: row.grp, services };
}

/** Replaces a project's membership. A project without a group keeps no services. */
export function setNetworkGroup(projectId: number, group: string | null, services: string[]): void {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare("UPDATE projects SET network_group = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(group, projectId);
    db.prepare("DELETE FROM network_group_services WHERE project_id = ?").run(projectId);
    if (!group) return;
    const insert = db.prepare("INSERT OR IGNORE INTO network_group_services (project_id, service) VALUES (?, ?)");
    for (const service of services) insert.run(projectId, service);
  })();
}

/** The other projects in a group, with the services each has joined. */
export function listNetworkGroupPeers(group: string, exceptProjectId: number): NetworkGroupPeer[] {
  const db = getDatabase();
  const projects = db.prepare("SELECT id, name FROM projects WHERE network_group = ? AND id <> ? ORDER BY name").all(group, exceptProjectId) as { id: number; name: string }[];
  const services = db.prepare("SELECT service FROM network_group_services WHERE project_id = ? ORDER BY service");
  return projects.map((p) => ({ projectId: p.id, name: p.name, services: (services.all(p.id) as { service: string }[]).map((r) => r.service) }));
}

/** Projects that are in a group, for the start-up reconcile. */
export function listProjectsInNetworkGroups(): number[] {
  return (getDatabase().prepare("SELECT id FROM projects WHERE network_group IS NOT NULL").all() as { id: number }[]).map((r) => r.id);
}

export interface NetworkGroupOverview { group: string; projects: { projectId: number; name: string; visualGroup: string | null; services: string[] }[] }

/** Every network group with its member projects and the services each has joined. */
export function listNetworkGroups(): NetworkGroupOverview[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT id, name, group_name AS visualGroup, network_group AS grp FROM projects WHERE network_group IS NOT NULL ORDER BY network_group, name").all() as { id: number; name: string; visualGroup: string | null; grp: string }[];
  const services = db.prepare("SELECT service FROM network_group_services WHERE project_id = ? ORDER BY service");
  const groups = new Map<string, NetworkGroupOverview>();
  for (const row of rows) {
    const entry = groups.get(row.grp) ?? { group: row.grp, projects: [] };
    entry.projects.push({ projectId: row.id, name: row.name, visualGroup: row.visualGroup, services: (services.all(row.id) as { service: string }[]).map((r) => r.service) });
    groups.set(row.grp, entry);
  }
  return [...groups.values()];
}
