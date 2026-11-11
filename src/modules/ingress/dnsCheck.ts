import crypto from "crypto";
import dns from "dns";
import os from "os";
import { getDatabase } from "../../config/database";
import { listProjectDomains } from "./domains";
import { getManagedDomain, recordDnsResult, type DnsStatus } from "./managedDomains";

/**
 * DNS checks for the domain manager (docs/1.3.7/domain-manager.md §3).
 *
 * A managed base domain is checked by resolving a random name under it: if that resolves to this server, a wildcard record
 * exists and every new hostname works with no further DNS work. If it does not, each hostname is checked by itself. A failing
 * check never blocks adding a hostname; it blocks issuing a certificate, and says why. The resolver is injected, so nothing
 * here needs a real domain to be tested.
 */

/** The A records of a name; empty (or a rejection) when it does not resolve. */
export type Resolver = (name: string) => Promise<string[]>;

export const systemResolver: Resolver = async (name) => {
  try { return await dns.promises.resolve4(name); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
    throw err;
  }
};

export interface DnsResult { status: DnsStatus; detail: string }

// ---- this server's public address

const ADDRESS_KEY = "server_public_address";
// eslint-disable-next-line security/detect-unsafe-regex -- four bounded groups; measured under 0.2 ms on 100 000 character input.
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isPublicIPv4(address: string): boolean {
  if (!IPV4.test(address)) return false;
  const [a, b] = address.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** The first public IPv4 address on one of this machine's interfaces: right on a server with a public address, and absent
 *  behind NAT, where the address has to be entered. */
export function detectPublicAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal && isPublicIPv4(entry.address)) return entry.address;
  }
  return null;
}

export interface ServerAddress { address: string | null; source: "setting" | "detected" | "none"; setting: string | null; detected: string | null }

export function getServerAddress(): ServerAddress {
  const row = getDatabase().prepare("SELECT value FROM app_meta WHERE key = ?").get(ADDRESS_KEY) as { value: string } | undefined;
  const setting = row?.value && IPV4.test(row.value) ? row.value : null;
  const detected = detectPublicAddress();
  return { address: setting ?? detected, source: setting ? "setting" : detected ? "detected" : "none", setting, detected };
}

/** Sets the address, or clears it (null) so detection is used again. */
export function setServerAddress(value: unknown): void {
  const db = getDatabase();
  if (value === null || value === "") { db.prepare("DELETE FROM app_meta WHERE key = ?").run(ADDRESS_KEY); return; }
  if (typeof value !== "string" || !IPV4.test(value.trim())) throw new Error("Enter an IPv4 address such as 203.0.113.10.");
  db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ADDRESS_KEY, value.trim());
}

// ---- checks

export async function checkName(name: string, address: string | null, resolver: Resolver): Promise<DnsResult> {
  if (!address) return { status: "unknown", detail: "This server's public address is not known, so DNS cannot be compared. Set it on the Domains page." };
  let found: string[];
  try { found = await resolver(name); }
  catch { return { status: "unknown", detail: `The lookup of ${name} failed; try again.` }; }
  if (found.length === 0) return { status: "not-resolving", detail: `${name} does not resolve. Add an A record pointing at ${address}.` };
  if (found.includes(address)) return { status: "ok", detail: `${name} resolves to ${address}.` };
  return { status: "points-elsewhere", detail: `${name} resolves to ${found.join(", ")}, not to this server (${address}).` };
}

/** A base domain: does a name nobody created resolve here? Then a wildcard record covers every hostname. */
export async function checkBaseDomain(name: string, address: string | null, resolver: Resolver): Promise<DnsResult> {
  const probe = `sp-check-${crypto.randomBytes(5).toString("hex")}.${name}`;
  const result = await checkName(probe, address, resolver);
  if (result.status === "ok") return { status: "ok", detail: `A wildcard record points ${name} here: every new hostname resolves with no further DNS work.` };
  if (result.status === "unknown") return result;
  return { status: result.status, detail: `No wildcard record points here (${probe} ${result.status === "not-resolving" ? "does not resolve" : "resolves elsewhere"}): each hostname needs its own record.` };
}

const SEVERITY: Record<DnsStatus, number> = { ok: 0, unknown: 1, "not-resolving": 2, "points-elsewhere": 3 };

/** A hostname, and the other name that redirects to it (www or the bare domain), since the certificate covers both: the
 *  worse of the two results is the result. */
export async function checkHostname(hostname: string, alsoAnswers: string | null, address: string | null, resolver: Resolver): Promise<DnsResult> {
  const main = await checkName(hostname, address, resolver);
  if (!alsoAnswers) return main;
  const other = await checkName(alsoAnswers, address, resolver);
  return SEVERITY[other.status] > SEVERITY[main.status] ? other : main;
}

function recordHostnameDns(domainId: number, result: DnsResult): void {
  getDatabase().prepare("UPDATE project_domains SET dns_status = ?, dns_detail = ?, dns_checked_at = ? WHERE id = ?").run(result.status, result.detail, new Date().toISOString(), domainId);
}

/** The other name a hostname's certificate covers, as nginx serves it: the bare domain behind a canonical www, or www in front
 *  of a bare domain (and not of a hostname that has its own www row). */
export function alsoAnswersFor(row: { domain: string; label: string | null; redirectApex: boolean }, allHostnames: Set<string>): string | null {
  const host = row.domain.toLowerCase();
  if (row.redirectApex && host.startsWith("www.")) return host.slice(4);
  if (row.label === "@" && !allHostnames.has(`www.${host}`)) return `www.${host}`;
  return null;
}

/** Checks a managed base domain and every hostname on it, and records the results. */
export async function runDnsChecks(managedDomainId: number, resolver: Resolver = systemResolver): Promise<{ domain: DnsResult; hostnames: { id: number; domain: string; result: DnsResult }[] } | null> {
  const base = getManagedDomain(managedDomainId);
  if (!base) return null;
  const { address } = getServerAddress();
  const domain = await checkBaseDomain(base.name, address, resolver);
  recordDnsResult(base.id, domain.status, domain.detail);

  const rows = getDatabase().prepare("SELECT DISTINCT project_id FROM project_domains WHERE managed_domain_id = ?").all(base.id) as { project_id: number }[];
  const all = new Set((getDatabase().prepare("SELECT domain FROM project_domains").all() as { domain: string }[]).map((r) => r.domain.toLowerCase()));
  const hostnames: { id: number; domain: string; result: DnsResult }[] = [];
  for (const { project_id } of rows) {
    for (const host of listProjectDomains(project_id).filter((d) => d.managedDomainId === base.id)) {
      const result = await checkHostname(host.domain, alsoAnswersFor(host, all), address, resolver);
      recordHostnameDns(host.id, result);
      hostnames.push({ id: host.id, domain: host.domain, result });
    }
  }
  return { domain, hostnames };
}

// ---- gating certificate issuance

export interface Gate { ok: boolean; reason?: string }

/**
 * A certificate can only be issued for a hostname that already resolves here: Let's Encrypt validates over HTTP, and a
 * failed attempt counts against its rate limits. Applies to hostnames on a managed domain, and only when this server's
 * address is known (otherwise there is nothing to compare, and issuing is left to try). The check is live, so a record
 * added a minute ago passes.
 */
export async function dnsGate(hostname: string, resolver: Resolver = systemResolver): Promise<Gate> {
  const row = getDatabase().prepare("SELECT id, domain, label, redirect_apex, managed_domain_id FROM project_domains WHERE lower(domain) = lower(?)").get(hostname) as
    { id: number; domain: string; label: string | null; redirect_apex: number; managed_domain_id: number | null } | undefined;
  if (!row || row.managed_domain_id === null) return { ok: true };
  const { address } = getServerAddress();
  if (!address) return { ok: true };
  const all = new Set((getDatabase().prepare("SELECT domain FROM project_domains").all() as { domain: string }[]).map((r) => r.domain.toLowerCase()));
  const result = await checkHostname(row.domain, alsoAnswersFor({ domain: row.domain, label: row.label, redirectApex: row.redirect_apex === 1 }, all), address, resolver);
  recordHostnameDns(row.id, result);
  if (result.status === "ok" || result.status === "unknown") return { ok: true };
  return { ok: false, reason: `${result.detail} Create the DNS record first, then issue the certificate.` };
}
