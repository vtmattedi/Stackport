import type { StatusSection, StatusSnapshot } from "./types";

/**
 * What a token may see. A token with no project group sees everything. A token limited to a group sees that group's projects and, for them,
 * their actions and alerts, and nothing about the host: host metrics describe the whole machine, which is more than the group, so a
 * scoped token gets `host: null` rather than numbers that include other groups' load.
 */

export type Scope = { group: string | null };

export function scopeSnapshot(snapshot: StatusSnapshot, scope: Scope): StatusSnapshot {
  if (scope.group === null) return snapshot;
  const projects = snapshot.projects.filter((project) => project.group === scope.group);
  const ids = new Set(projects.map((project) => project.id));
  return {
    host: null,
    projects,
    actions: snapshot.actions.filter((action) => action.projectId !== null && ids.has(action.projectId)),
    alerts: snapshot.alerts.filter((alert) => alert.scope === "project" && alert.projectId !== null && ids.has(alert.projectId)),
  };
}

/** One section of the scoped snapshot, for an update message. Scoping a whole snapshot and taking the section keeps the rules in one place. */
export function scopeSection<S extends StatusSection>(snapshot: StatusSnapshot, section: S, scope: Scope): StatusSnapshot[S] {
  // eslint-disable-next-line security/detect-object-injection -- the key is one of the fixed section names.
  return scopeSnapshot(snapshot, scope)[section];
}
