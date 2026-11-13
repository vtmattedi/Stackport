import { getDatabase } from "../../config/database";
import { DOMAIN_RE } from "./domainName";
import { getNginxAppConfig } from "./nginx/appConfig";
import { addProjectDomain, ensureDomainAvailable, getProjectDomain, listProjectDomains, ProjectDomainError, removeProjectDomain, setProjectDomainRoute, setProjectDomainSsl, type ProjectDomain } from "./domains";

/**
 * The domain manager (see Stackport.md, domain routing model): the base domains Stackport manages, and hostnames made as a label on one
 * of them. `project_domains.domain` stays the full hostname, so nginx, Certbot and the health checker do not change.
 */

export interface ManagedDomain {
  id: number;
  name: string;
  isDefault: boolean;
  /** Hostnames made from it. */
  hostnameCount: number;
  createdAt: string;
}

interface DomainRow {
  id: number; name: string; is_default: number; created_at: string; hostname_count: number;
}

const SELECT = `SELECT d.id, d.name, d.is_default, d.created_at,
  (SELECT COUNT(*) FROM project_domains p WHERE p.managed_domain_id = d.id) AS hostname_count FROM managed_domains d`;

function toDomain(row: DomainRow): ManagedDomain {
  return { id: row.id, name: row.name, isDefault: row.is_default === 1, hostnameCount: row.hostname_count, createdAt: row.created_at };
}

export function listManagedDomains(): ManagedDomain[] {
  return (getDatabase().prepare(`${SELECT} ORDER BY d.is_default DESC, d.name`).all() as DomainRow[]).map(toDomain);
}

export function getManagedDomain(id: number): ManagedDomain | null {
  const row = getDatabase().prepare(`${SELECT} WHERE d.id = ?`).get(id) as DomainRow | undefined;
  return row ? toDomain(row) : null;
}

export function getDefaultManagedDomain(): ManagedDomain | null {
  const row = getDatabase().prepare(`${SELECT} WHERE d.is_default = 1`).get() as DomainRow | undefined;
  return row ? toDomain(row) : null;
}

// ---- rules

/** One DNS label: letters, digits and hyphens, 1 to 63 characters, not starting or ending with a hyphen. No dots. */
// eslint-disable-next-line security/detect-unsafe-regex -- the repeat is bounded to 61 characters; measured under 0.1 ms on 100 000 character input.
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The label that means the bare domain itself (`example.com`). */
export const APEX_LABEL = "@";

/** Never given out automatically to a project named like it. A person can still choose `www` on purpose: it is the
 *  other half of the bare domain (see `canonical` below). */
const AUTO_SKIP_LABELS = new Set(["www"]);

export type Canonical = "apex" | "www";

export function hostnameFor(label: string, baseName: string): string {
  return label === APEX_LABEL ? baseName : `${label}.${baseName}`;
}

export function parseBaseDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return name && DOMAIN_RE.test(name) ? name : null;
}

/** A label, or `@` for the bare domain. */
export function validateLabel(value: unknown, base: string): string {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (label !== APEX_LABEL && !LABEL_RE.test(label)) throw new ProjectDomainError(400, "The label must be 1 to 63 letters, digits or hyphens, and not start or end with a hyphen. Dots are not allowed. Use @ for the bare domain.");
  const app = getNginxAppConfig();
  if (app.enabled && app.domain && hostnameFor(label, base) === app.domain.toLowerCase()) throw new ProjectDomainError(409, "That hostname is reserved for Stackport itself.");
  return label;
}

/** A project name as a label: lower case, other characters as hyphens, at most 63 characters. */
export function slugify(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return slug || "project";
}

// ---- base domains

/** Adds a base domain. The first one becomes the default. Existing hostnames made of one label in front of it are adopted. */
export function addManagedDomain(nameInput: unknown, makeDefault = false): ManagedDomain {
  const name = parseBaseDomain(nameInput);
  if (!name) throw new ProjectDomainError(400, "Enter a domain such as example.com or apps.example.com.");
  const db = getDatabase();
  if (db.prepare("SELECT 1 FROM managed_domains WHERE name = ?").get(name)) throw new ProjectDomainError(409, "That domain is already managed.");
  const app = getNginxAppConfig();
  if (app.enabled && app.domain && name === app.domain.toLowerCase()) throw new ProjectDomainError(409, "That is Stackport's own address: managing it would hand out hostnames next to the admin site.");
  const isFirst = (db.prepare("SELECT COUNT(*) AS n FROM managed_domains").get() as { n: number }).n === 0;
  const id = db.transaction(() => {
    if (makeDefault && !isFirst) db.prepare("UPDATE managed_domains SET is_default = 0").run();
    const result = db.prepare("INSERT INTO managed_domains (name, is_default) VALUES (?, ?)").run(name, makeDefault || isFirst ? 1 : 0);
    return Number(result.lastInsertRowid);
  })();
  adoptHostnames();
  return getManagedDomain(id) as ManagedDomain;
}

export function setDefaultManagedDomain(id: number): ManagedDomain | null {
  const db = getDatabase();
  if (!getManagedDomain(id)) return null;
  db.transaction(() => {
    db.prepare("UPDATE managed_domains SET is_default = 0").run();
    db.prepare("UPDATE managed_domains SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  })();
  return getManagedDomain(id);
}

/** A base domain cannot go while a hostname uses it. If it was the default, no other becomes it on its own. */
export function removeManagedDomain(id: number): boolean {
  const domain = getManagedDomain(id);
  if (!domain) return false;
  if (domain.hostnameCount > 0) throw new ProjectDomainError(409, `${domain.hostnameCount} hostname${domain.hostnameCount === 1 ? " uses" : "s use"} ${domain.name}. Move or remove ${domain.hostnameCount === 1 ? "it" : "them"} first.`);
  return getDatabase().prepare("DELETE FROM managed_domains WHERE id = ?").run(id).changes > 0;
}

// ---- adoption

/** Splits a hostname on the longest base domain it is on: `@` when it is the base domain itself, otherwise everything in
 *  front of it (which may not be one valid label). Null when it is not on any base. */
function splitOnBase<B extends { name: string }>(host: string, bases: B[]): { base: B; label: string } | null {
  const sorted = [...bases].sort((a, b) => b.name.length - a.name.length);
  const bare = sorted.find((b) => b.name === host);
  if (bare) return { base: bare, label: APEX_LABEL };
  const base = sorted.find((b) => host.endsWith(`.${b.name}`));
  return base ? { base, label: host.slice(0, host.length - base.name.length - 1) } : null;
}

/** Links existing hostnames to a managed base domain: the bare domain itself (`@`), or a hostname with exactly one label in
 *  front of it (`www` included), to the longest matching base domain. Everything else stays unmanaged and keeps working.
 *  No hostname is changed. */
export function adoptHostnames(): number {
  const db = getDatabase();
  const bases = db.prepare("SELECT id, name FROM managed_domains").all() as { id: number; name: string }[];
  if (bases.length === 0) return 0;
  const rows = db.prepare("SELECT id, domain FROM project_domains WHERE managed_domain_id IS NULL").all() as { id: number; domain: string }[];
  let adopted = 0;
  const update = db.prepare("UPDATE project_domains SET managed_domain_id = ?, label = ? WHERE id = ?");
  for (const row of rows) {
    const host = row.domain.toLowerCase();
    const split = splitOnBase(host, bases);
    if (!split || (split.label !== APEX_LABEL && !LABEL_RE.test(split.label))) continue; // not on a base, or more than one label: stays unmanaged
    update.run(split.base.id, split.label, row.id);
    adopted += 1;
  }
  return adopted;
}

// ---- hostnames

function hostnameTaken(hostname: string): boolean {
  return !!getDatabase().prepare("SELECT 1 FROM project_domains WHERE lower(domain) = lower(?)").get(hostname);
}

/** The first free label for a project: its slug, then slug-2, slug-3... */
export function reserveLabel(base: ManagedDomain, name: string): string {
  const slug = slugify(name);
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const label = `${slug.slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (AUTO_SKIP_LABELS.has(label)) continue;
    if (!hostnameTaken(`${label}.${base.name}`)) {
      try { validateLabel(label, base.name); return label; } catch { /* reserved for Stackport: try the next */ }
    }
  }
  throw new ProjectDomainError(409, "No free hostname could be found for this project name.");
}

/**
 * A hostname made from a label and a base domain the admin chose.
 *
 * For the bare domain (`@`) there are two ways to serve `example.com` and `www.example.com` together, and the admin picks the
 * canonical one: `apex` makes `example.com` the hostname, and `www.example.com` redirects to it (what nginx does for any bare
 * domain); `www` makes `www.example.com` the hostname and `example.com` redirects to it. Either way one certificate covers both.
 * `www` chosen as a plain label is a hostname of its own, with no redirect.
 */
export function addManagedProjectDomain(projectId: number, managedDomainId: unknown, labelInput: unknown, service = "", containerPort: number | null = null, canonical: Canonical = "apex"): ProjectDomain {
  const base = typeof managedDomainId === "number" ? getManagedDomain(managedDomainId) : null;
  if (!base) throw new ProjectDomainError(400, "Choose one of the managed domains.");
  const label = validateLabel(labelInput, base.name);
  if (label === APEX_LABEL && canonical === "www") {
    // The bare domain is answered by the redirect, so it has to be free too.
    ensureDomainAvailable(base.name);
    return addProjectDomain(projectId, `www.${base.name}`, false, service, containerPort, { managedDomainId: base.id, label: "www", redirectApex: true });
  }
  return addProjectDomain(projectId, hostnameFor(label, base.name), false, service, containerPort, { managedDomainId: base.id, label });
}

/**
 * A new project may only be routed to a base domain or to a subdomain of one: the bare base domain (label `@`), or one label in
 * front of it. Anything else is refused with the base domains that are available. Returns what the hostname is made of.
 */
export function resolveBaseHostname(input: unknown): { managedDomainId: number; label: string; hostname: string } {
  const host = typeof input === "string" ? input.trim().toLowerCase() : "";
  const bases = listManagedDomains();
  if (bases.length === 0) throw new ProjectDomainError(400, "Add a base domain in Settings > Domains first: a new project can only be routed to a base domain or a subdomain of one.");
  const split = splitOnBase(host, bases);
  if (!split) throw new ProjectDomainError(400, `"${host}" is not on a base domain. A new project can only be routed to a base domain or a subdomain of one (${bases.map((b) => b.name).join(", ")}).`);
  const { base, label } = split;
  if (label !== APEX_LABEL && !LABEL_RE.test(label)) throw new ProjectDomainError(400, `"${host}" has more than one label in front of ${base.name}. Use one label, such as shop.${base.name}.`);
  validateLabel(label, base.name); // also keeps Stackport's own address out of reach, for the bare domain too
  return { managedDomainId: base.id, label, hostname: host };
}

// ---- the overview

export interface HostnameOverview {
  id: number;
  projectId: number;
  projectName: string;
  domain: string;
  /** The base domain it was made from, or null for an unmanaged hostname. */
  baseDomain: string | null;
  label: string | null;
  /** The bare domain (or www) that redirects to this hostname, when there is one. */
  alsoAnswers: string | null;
  service: string;
  containerPort: number | null;
  useSsl: boolean;
}

/** Every hostname with its project and route, for the central Domains page. */
export function listHostnames(): HostnameOverview[] {
  const rows = getDatabase().prepare(
    `SELECT p.id, p.project_id, pr.name AS project_name, p.domain, p.label, p.redirect_apex, p.service, p.container_port, p.use_ssl, d.name AS base_name
       FROM project_domains p JOIN projects pr ON pr.id = p.project_id LEFT JOIN managed_domains d ON d.id = p.managed_domain_id
      ORDER BY lower(p.domain)`,
  ).all() as { id: number; project_id: number; project_name: string; domain: string; label: string | null; redirect_apex: number; service: string; container_port: number | null; use_ssl: number; base_name: string | null }[];
  const all = new Set(rows.map((r) => r.domain.toLowerCase()));
  return rows.map((r) => {
    const host = r.domain.toLowerCase();
    // nginx answers the other name with a redirect: www in front of a bare domain, or the bare domain behind a canonical www.
    const alsoAnswers = r.redirect_apex === 1 && host.startsWith("www.") ? host.slice(4)
      : !host.startsWith("www.") && !all.has(`www.${host}`) && r.label === APEX_LABEL ? `www.${host}` : null;
    return {
      id: r.id, projectId: r.project_id, projectName: r.project_name, domain: r.domain, baseDomain: r.base_name, label: r.label, alsoAnswers,
      service: r.service, containerPort: r.container_port, useSsl: r.use_ssl === 1,
    };
  });
}

// ---- a hostname for a new project

/** Reserves `<project-name>.<default domain>` for a project that has just been created, with no route yet: the Compose file
 *  is not known until the repository is cloned. SSL stays off. Returns null when no base domain is managed. */
export function reserveHostnameForProject(projectId: number, projectName: string): ProjectDomain | null {
  const base = getDefaultManagedDomain();
  if (!base) return null;
  const label = reserveLabel(base, projectName);
  return addProjectDomain(projectId, hostnameFor(label, base.name), false, "", null, { managedDomainId: base.id, label });
}

/** The project's one managed hostname that has no route yet. With none, or with several, there is no way to know which
 *  one a service is meant for, so nothing is chosen. */
export function findUnroutedManagedHostname(projectId: number): ProjectDomain | null {
  const unrouted = listProjectDomains(projectId).filter((d) => d.managedDomainId !== null && (!d.service || !d.containerPort));
  return unrouted.length === 1 ? unrouted[0] : null;
}

/** Routes a reserved hostname when the Compose file declares exactly one routable port. With several, it stays "pick a
 *  service": guessing between them is how traffic reaches the wrong one. Returns the hostname that was routed. */
export function routeReservedHostname(projectId: number, targets: { service: string; containerPort: number }[]): ProjectDomain | null {
  const pending = findUnroutedManagedHostname(projectId);
  if (!pending || targets.length !== 1) return null;
  return setProjectDomainRoute(projectId, pending.id, targets[0].service, targets[0].containerPort);
}

// ---- renaming a hostname

export interface RenameDeps {
  /** Rewrites and applies nginx's config from the current rows. */
  applyNginx: () => Promise<{ ok: boolean; message: string }>;
  /** Issues a certificate for a hostname; its HTTP route is already live. */
  issueCertificate: (domain: string) => Promise<{ ok: boolean; message: string }>;
}

export interface RenameResult { ok: boolean; steps: string[]; reason?: string; hostname?: ProjectDomain }

/**
 * Renames a hostname. The new one is added and routed first, its certificate is issued if the old one had SSL, and only then
 * is the old one removed: at no point is the project without a working hostname. If any step before the removal fails the new
 * hostname is taken away again and the old one is untouched. The old hostname stops working at once, with no redirect.
 * Renaming a project never renames its hostname; this is the only way one changes.
 */
export async function renameProjectHostname(
  projectId: number, domainId: number, target: { managedDomainId: unknown; label: unknown; canonical?: Canonical }, deps: RenameDeps,
): Promise<RenameResult> {
  const steps: string[] = [];
  const old = getProjectDomain(projectId, domainId);
  if (!old) return { ok: false, steps, reason: "Hostname not found." };
  let created: ProjectDomain;
  try {
    created = addManagedProjectDomain(projectId, target.managedDomainId, target.label, old.service, old.containerPort, target.canonical ?? "apex");
  } catch (err) {
    return { ok: false, steps, reason: err instanceof ProjectDomainError ? err.message : "The new hostname could not be added." };
  }
  if (created.domain.toLowerCase() === old.domain.toLowerCase()) {
    removeProjectDomain(projectId, created.id);
    return { ok: false, steps, reason: "That is already this hostname." };
  }
  steps.push(`Added ${created.domain}${old.service ? ` routed to ${old.service}:${old.containerPort}` : ""}.`);

  const undo = async (reason: string): Promise<RenameResult> => {
    removeProjectDomain(projectId, created.id);
    await deps.applyNginx().catch(() => undefined);
    steps.push(`Undone: ${old.domain} is as it was.`);
    return { ok: false, steps, reason };
  };

  const applied = await deps.applyNginx();
  if (!applied.ok) return undo(`nginx refused the new hostname: ${applied.message.trim() || "no message"}.`);
  steps.push("nginx serves the new hostname.");

  if (old.useSsl) {
    const issued = await deps.issueCertificate(created.domain);
    if (!issued.ok) return undo(`A certificate could not be issued for ${created.domain}: ${issued.message.trim() || "no message"}.`);
    setProjectDomainSsl(projectId, created.id, true);
    const secured = await deps.applyNginx();
    if (!secured.ok) { setProjectDomainSsl(projectId, created.id, false); return undo(`nginx refused the certificate for ${created.domain}: ${secured.message.trim() || "no message"}.`); }
    steps.push(`A certificate was issued for ${created.domain}.`);
  }

  removeProjectDomain(projectId, old.id);
  const final = await deps.applyNginx();
  steps.push(`${old.domain} was removed and no longer answers.${final.ok ? "" : ` (nginx reported: ${final.message.trim()}; the next apply retries it)`}`);
  return { ok: true, steps, hostname: getProjectDomain(projectId, created.id) ?? created };
}
