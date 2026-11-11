import { getDatabase } from "../../config/database";
import { DOMAIN_RE } from "./domainName";
import { getNginxAppConfig } from "./nginx/appConfig";
import { addProjectDomain, ensureDomainAvailable, ProjectDomainError, type ProjectDomain } from "./domains";

/**
 * The domain manager (docs/1.3.7/domain-manager.md): the base domains Stackport manages, and hostnames made as a label on one
 * of them. `project_domains.domain` stays the full hostname, so nginx, Certbot and the health checker do not change.
 */

export type DnsStatus = "unknown" | "ok" | "not-resolving" | "points-elsewhere";

export interface ManagedDomain {
  id: number;
  name: string;
  isDefault: boolean;
  dnsStatus: DnsStatus;
  dnsCheckedAt: string | null;
  dnsDetail: string | null;
  /** Hostnames made from it. */
  hostnameCount: number;
  createdAt: string;
}

interface DomainRow {
  id: number; name: string; is_default: number; dns_status: string; dns_checked_at: string | null; dns_detail: string | null; created_at: string; hostname_count: number;
}

const SELECT = `SELECT d.id, d.name, d.is_default, d.dns_status, d.dns_checked_at, d.dns_detail, d.created_at,
  (SELECT COUNT(*) FROM project_domains p WHERE p.managed_domain_id = d.id) AS hostname_count FROM managed_domains d`;

function toDomain(row: DomainRow): ManagedDomain {
  const dnsStatus = (["unknown", "ok", "not-resolving", "points-elsewhere"] as const).find((s) => s === row.dns_status) ?? "unknown";
  return { id: row.id, name: row.name, isDefault: row.is_default === 1, dnsStatus, dnsCheckedAt: row.dns_checked_at, dnsDetail: row.dns_detail, hostnameCount: row.hostname_count, createdAt: row.created_at };
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

export function recordDnsResult(id: number, status: DnsStatus, detail: string | null): void {
  getDatabase().prepare("UPDATE managed_domains SET dns_status = ?, dns_detail = ?, dns_checked_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, detail, new Date().toISOString(), id);
}

// ---- adoption

/** Links existing hostnames to a managed base domain: the bare domain itself (`@`), or a hostname with exactly one label in
 *  front of it (`www` included), to the longest matching base domain. Everything else stays unmanaged and keeps working.
 *  No hostname is changed. */
export function adoptHostnames(): number {
  const db = getDatabase();
  const bases = (db.prepare("SELECT id, name FROM managed_domains").all() as { id: number; name: string }[]).sort((a, b) => b.name.length - a.name.length);
  if (bases.length === 0) return 0;
  const rows = db.prepare("SELECT id, domain FROM project_domains WHERE managed_domain_id IS NULL").all() as { id: number; domain: string }[];
  let adopted = 0;
  const update = db.prepare("UPDATE project_domains SET managed_domain_id = ?, label = ? WHERE id = ?");
  for (const row of rows) {
    const host = row.domain.toLowerCase();
    const bare = bases.find((b) => b.name === host);
    if (bare) { update.run(bare.id, APEX_LABEL, row.id); adopted += 1; continue; }
    const base = bases.find((b) => host.endsWith(`.${b.name}`));
    if (!base) continue;
    const label = host.slice(0, host.length - base.name.length - 1);
    if (!LABEL_RE.test(label)) continue; // more than one label, or not a valid one: stays unmanaged
    update.run(base.id, label, row.id);
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
