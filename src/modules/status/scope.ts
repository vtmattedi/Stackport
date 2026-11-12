import type { StatusSection, StatusSnapshot } from "./types";

/**
 * What a token may see. A token with no project group sees everything. A token limited to a group sees that group's projects and, for them,
 * their actions and alerts, and nothing about the host: host metrics describe the whole machine, which is more than the group, so a
 * scoped token gets `host: null` rather than numbers that include other groups' load.
 *
 * A project is in the group when its group, as stored, is exactly the token's. The snapshot's own `group` is cleaned and cut for the wire and
 * is not used for this: cleaning two different names to the same text would show one group to the other's token.
 */

export type Scope = { group: string | null };
export type RawGroups = ReadonlyMap<number, string | null>;

export function scopeSnapshot(snapshot: StatusSnapshot, scope: Scope, groups: RawGroups): StatusSnapshot {
  if (scope.group === null) return snapshot;
  const projects = snapshot.projects.filter((project) => groups.get(project.id) === scope.group);
  const ids = new Set(projects.map((project) => project.id));
  return {
    host: null,
    projects,
    actions: snapshot.actions.filter((action) => action.projectId !== null && ids.has(action.projectId)),
    alerts: snapshot.alerts.filter((alert) => alert.scope === "project" && alert.projectId !== null && ids.has(alert.projectId)),
  };
}

/** One section of the scoped snapshot, for an update message. Scoping a whole snapshot and taking the section keeps the rules in one place. */
export function scopeSection<S extends StatusSection>(snapshot: StatusSnapshot, section: S, scope: Scope, groups: RawGroups): StatusSnapshot[S] {
  // eslint-disable-next-line security/detect-object-injection -- the key is one of the fixed section names.
  return scopeSnapshot(snapshot, scope, groups)[section];
}
