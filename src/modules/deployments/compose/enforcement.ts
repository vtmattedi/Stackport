import { getDatabase } from "../../../config/database";

/**
 * Which 1.3 protections each project has (G2).
 *
 * New projects start with every protection on. A project that existed before 1.3 keeps the
 * old behaviour until someone switches it, so an admin needs one place that says which
 * projects are still unprotected, and a way to enforce the Compose policy on one.
 *
 * Managed volumes have no plain switch on purpose: turning them on without copying the
 * data would start the project on an empty directory. The temporary migration does it.
 */

export interface ProjectEnforcement {
  id: number;
  name: string;
  composePolicyEnforced: boolean;
  volumesManaged: boolean;
  hardenedDefaults: boolean;
}

interface EnforcementRow {
  id: number;
  name: string;
  compose_policy_enforced: number;
  volumes_managed: number;
  hardened_defaults: number;
}

/** Every project with its three flags, unprotected ones first. */
export function listProjectEnforcement(): ProjectEnforcement[] {
  const rows = getDatabase()
    .prepare("SELECT id, name, compose_policy_enforced, volumes_managed, hardened_defaults FROM projects ORDER BY name COLLATE NOCASE")
    .all() as EnforcementRow[];
  const projects = rows.map((row) => ({
    id: row.id,
    name: row.name,
    composePolicyEnforced: row.compose_policy_enforced !== 0,
    volumesManaged: row.volumes_managed !== 0,
    hardenedDefaults: row.hardened_defaults !== 0,
  }));
  const unprotected = (p: ProjectEnforcement): number => Number(!p.composePolicyEnforced) + Number(!p.volumesManaged) + Number(!p.hardenedDefaults);
  return projects.sort((a, b) => unprotected(b) - unprotected(a));
}

/** Returns false when the project does not exist. Takes effect on the project's next deploy. */
export function setComposePolicyEnforced(projectId: number, enforced: boolean): boolean {
  const result = getDatabase()
    .prepare("UPDATE projects SET compose_policy_enforced = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(enforced ? 1 : 0, projectId);
  return result.changes > 0;
}
