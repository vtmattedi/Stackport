/**
 * What a controlling peer may do on THIS instance, granted by this instance's admin when the
 * pairing code is created. Grants are enforced here (on the managed side), never on the caller.
 *
 * Global host administration (host settings, updates, backups, other peers, the instance's own
 * credentials) is deliberately not grantable: it is a separate boundary from project control.
 * Anything from `projects:write` up can edit Compose files and run arbitrary containers, which
 * under today's Docker-socket model is host-equivalent. These are access levels, not a sandbox.
 */
export const GRANTS = [
  "projects:read", // list/inspect projects, status, health, logs, action history
  "projects:write", // create, configure, deploy, rebuild, stop, restart, roll back, domains and routing
  "projects:env", // read and edit managed env files, with secret values masked
  "projects:secrets", // reveal secret values
  "projects:shell", // interactive container shell
  "projects:destroy", // delete projects and their data
] as const;
export type Grant = (typeof GRANTS)[number];

/** Each grant needs these too: a peer that can edit env files must at least see the project. */
const IMPLIES = new Map<Grant, Grant[]>(Object.entries({
  "projects:read": [],
  "projects:write": ["projects:read"],
  "projects:env": ["projects:read"],
  "projects:secrets": ["projects:env", "projects:read"],
  "projects:shell": ["projects:write", "projects:read"],
  "projects:destroy": ["projects:write", "projects:read"],
} as Record<Grant, Grant[]>) as [Grant, Grant[]][]);

export class GrantError extends Error {}

export function isGrant(value: unknown): value is Grant {
  return typeof value === "string" && (GRANTS as readonly string[]).includes(value);
}

/** Validates and expands a requested set. Unknown grants are an error, not silently dropped. */
export function normalizeGrants(requested: unknown): Grant[] {
  if (!Array.isArray(requested) || requested.length === 0) throw new GrantError("Choose at least one grant.");
  const out = new Set<Grant>();
  for (const item of requested) {
    if (!isGrant(item)) throw new GrantError(`Unknown grant: ${String(item)}`);
    out.add(item);
    for (const implied of IMPLIES.get(item) ?? []) out.add(implied);
  }
  return GRANTS.filter((g) => out.has(g));
}

export function serializeGrants(grants: readonly Grant[]): string {
  return grants.join(",");
}

export function parseGrants(stored: string): Grant[] {
  return stored.split(",").filter(isGrant);
}

export function hasGrant(grants: readonly Grant[], needed: Grant): boolean {
  return grants.includes(needed);
}
