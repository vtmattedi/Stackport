import { execFile } from "child_process";
import * as path from "path";
import { getDatabase } from "../config/database";
import { pollingCadenceS } from "../config/pollingCadence";
import { SingleFlightCache } from "../utils/singleFlightCache";
import { CERTBOT_WEBROOT_PATH, DOMAIN_RE, getNginxAppConfig, getNginxLayerStatus } from "./nginx/configWriter";

export type CertbotMode = "real";
export type CertbotAction = "issue" | "renew" | "delete";
export type CertbotDomainType = "domain" | "subdomain";

export interface CertbotEntry {
  domain: string;
  type: CertbotDomainType;
  hasCertificate: boolean;
  status: "missing" | "valid" | "expiring" | "expired" | "unknown";
  expiresAt: string | null;
  issuer: string | null;
  path: string | null;
}

export interface CertbotStatus {
  mode: CertbotMode;
  available: boolean;
  reason?: string;
  emailConfigured: boolean;
  email: string;
  rootPath: string;
  entries: CertbotEntry[];
}

export interface CertbotEmailConfig {
  email: string;
  emailConfigured: boolean;
  source: "client" | "env" | "none";
}

export interface CertbotActionResult {
  ok: boolean;
  mode: CertbotMode;
  domain: string;
  action: CertbotAction;
  output: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  notFound: boolean;
}

const CERTBOT_IMAGE = "certbot/certbot";
const CERTBOT_EMAIL_KEY = "certbot_email";

function envCertbotEmail(): string {
  return (process.env["CERTBOT_EMAIL"] ?? "").trim();
}

export function getCertbotEmailConfig(): CertbotEmailConfig {
  const row = getDatabase()
    .prepare("SELECT value FROM app_meta WHERE key = ?")
    .get(CERTBOT_EMAIL_KEY) as { value: string } | undefined;
  const storedEmail = row?.value.trim() ?? "";
  const envEmail = envCertbotEmail();
  const email = storedEmail || envEmail;

  return {
    email,
    emailConfigured: !!email,
    source: storedEmail ? "client" : envEmail ? "env" : "none",
  };
}

export function setCertbotEmail(email: string): CertbotEmailConfig {
  const normalized = email.trim();
  if (normalized) {
    getDatabase()
      .prepare(`
        INSERT INTO app_meta (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `)
      .run(CERTBOT_EMAIL_KEY, normalized);
  } else {
    getDatabase().prepare("DELETE FROM app_meta WHERE key = ?").run(CERTBOT_EMAIL_KEY);
  }

  return getCertbotEmailConfig();
}

function liveCertDir(domain: string): string {
  return path.join("/etc/letsencrypt/live", domain);
}

function statusFromExpiry(expiresAt: string | null): CertbotEntry["status"] {
  if (!expiresAt) return "unknown";
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return "unknown";
  const now = Date.now();
  if (expiresMs <= now) return "expired";
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return expiresMs - now <= thirtyDays ? "expiring" : "valid";
}

async function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const notFound = !!(err && (err as NodeJS.ErrnoException).code === "ENOENT");
      resolve({ stdout, stderr, ok: !err, notFound });
    });
  });
}





function domainType(domain: string, domainList: string[], subdomainList: string[]): CertbotDomainType {
  if (subdomainList.includes(domain)) return "subdomain";
  if (domainList.includes(domain)) return "domain";
  return "domain";
}

function parseOpenSslDate(value: string): string | null {
  const raw = value.trim().replace(/^notAfter=/, "");
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface CertExistenceEntry {
  exists: boolean;
  path: string;
}

interface CertExpiryEntry {
  expiresAt: string | null;
  issuer: string | null;
}

// Existence and expiry are cached separately (different cadences — see
// pollingCadence.ts) and batched across every routed domain in one fetch, rather than
// re-running `test -f`/`openssl x509` per domain on every status poll: with N routed
// domains, the old per-request approach meant `1 + 3N` subprocess spawns on every
// single poll tick, the dominant cost in the whole system-status collection.
// Root-only certificate directories are inspected through Docker. Only public
// certificate metadata is read; private keys remain inaccessible to the app user.
async function checkFileExists(filePath: string): Promise<RunResult> {
  return run("docker", ["exec", "stackport-nginx", "test", "-f", filePath], 12_000);
}
async function readOpenssl(args: string[]): Promise<RunResult> {
  const direct = await run("openssl", args, 12_000);
  return direct.ok ? direct : run("docker", ["exec", "stackport", "openssl", ...args], 12_000);
}

async function fetchCertExistence(): Promise<Map<string, CertExistenceEntry>> {
  const lists = await routedDomains();
  const entries = await Promise.all(lists.domains.map(async (domain): Promise<[string, CertExistenceEntry]> => {
    const certPath = path.join(liveCertDir(domain), "fullchain.pem");
    const exists = await checkFileExists(certPath);
    return [domain, { exists: exists.ok, path: certPath }];
  }));
  return new Map(entries);
}

async function fetchCertExpiry(): Promise<Map<string, CertExpiryEntry>> {
  const existence = await certExistenceCache.get();
  const domainsWithCerts = [...existence.entries()].filter(([, entry]) => entry.exists);
  const entries = await Promise.all(domainsWithCerts.map(async ([domain, entry]): Promise<[string, CertExpiryEntry]> => {
    const [endDate, issuer] = await Promise.all([
      readOpenssl(["x509", "-enddate", "-noout", "-in", entry.path]),
      readOpenssl(["x509", "-issuer", "-noout", "-in", entry.path]),
    ]);
    return [domain, {
      expiresAt: endDate.ok ? parseOpenSslDate(endDate.stdout) : null,
      issuer: issuer.ok ? issuer.stdout.trim().replace(/^issuer=/, "") : null,
    }];
  }));
  return new Map(entries);
}

const certExistenceCache = new SingleFlightCache<Map<string, CertExistenceEntry>>(
  fetchCertExistence,
  pollingCadenceS.certExistence * 1000,
);
const certExpiryCache = new SingleFlightCache<Map<string, CertExpiryEntry>>(
  fetchCertExpiry,
  pollingCadenceS.certExpiry * 1000,
);
const containerCertbotVersionCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["run", "--rm", "certbot/certbot", "--version"], 120_000),
  null,
);

/** Called right after a successful certbot issue/renew/delete (see runCertbotAction
 *  below, and certbotRenewalMonitor.ts's automatic renewal sweep) — the set of certs
 *  on disk and their expiry just changed. */
export function invalidateCertCaches(): void {
  certExistenceCache.invalidate();
  certExpiryCache.invalidate();
}

/** Refresh Certbot image availability. */
export function invalidateCertbotVersion(): void {
  containerCertbotVersionCache.invalidate();
}

async function routedDomains() {
  const layer = await getNginxLayerStatus();
  return {
    domains: layer.domains,
    domainList: layer.domainList,
    subdomainList: layer.subdomainList,
  };
}

async function resolveRoutedDomain(domain: string) {
  const normalized = domain.trim().toLowerCase();
  const lists = await routedDomains();
  if (!DOMAIN_RE.test(normalized) || !lists.domains.includes(normalized)) {
    return null;
  }
  return {
    domain: normalized,
    type: domainType(normalized, lists.domainList, lists.subdomainList),
  };
}

function shouldIssueWwwAlias(domain: string, type: CertbotDomainType): boolean {
  return type === "domain" && !domain.startsWith("www.") && domain !== getNginxAppConfig().domain;
}

export async function getCertbotStatus(): Promise<CertbotStatus> {
  const lists = await routedDomains();
  const [existence, expiry, version] = await Promise.all([
    certExistenceCache.get(),
    certExpiryCache.get(),
    containerCertbotVersionCache.get(),
  ]);

  const entries: CertbotEntry[] = lists.domains.map((domain) => {
    const type = domainType(domain, lists.domainList, lists.subdomainList);
    const certPath = path.join(liveCertDir(domain), "fullchain.pem");
    const existenceEntry = existence.get(domain);
    if (!existenceEntry?.exists) {
      return { domain, type, hasCertificate: false, status: "missing", expiresAt: null, issuer: null, path: existenceEntry?.path ?? certPath };
    }
    const expiryEntry = expiry.get(domain);
    const expiresAt = expiryEntry?.expiresAt ?? null;
    return {
      domain,
      type,
      hasCertificate: true,
      status: statusFromExpiry(expiresAt),
      expiresAt,
      issuer: expiryEntry?.issuer ?? null,
      path: existenceEntry.path,
    };
  });

  const emailConfig = getCertbotEmailConfig();
  return {
    mode: "real",
    available: version.ok,
    reason: version.ok ? undefined : (version.stderr || version.stdout || "Certbot container unavailable").trim(),
    emailConfigured: emailConfig.emailConfigured,
    email: emailConfig.email,
    rootPath: "/etc/letsencrypt/live",
    entries,
  };
}

async function containerAction(
  domain: string,
  type: CertbotDomainType,
  action: CertbotAction,
  opts: { staging?: boolean } = {}
): Promise<CertbotActionResult> {
  const letsencryptMount = ["-v", "/etc/letsencrypt:/etc/letsencrypt"];
  const webrootMount = ["-v", `${CERTBOT_WEBROOT_PATH}:/var/www/certbot`];
  let args: string[];
  let timeoutMs = 300_000;

  if (action === "issue") {
    const email = getCertbotEmailConfig().email;
    if (!email) {
      return { ok: false, mode: "real", domain, action, output: "CERTBOT_EMAIL is required for certbot issue actions." };
    }
    args = ["certonly", "--webroot", "-w", "/var/www/certbot", "-d", domain];
    if (shouldIssueWwwAlias(domain, type)) args.push("-d", `www.${domain}`);
    args.push("--non-interactive", "--agree-tos", "-m", email);
    if (opts.staging) args.push("--staging");
  } else if (action === "renew") {
    args = ["renew", "--cert-name", domain, "--webroot", "-w", "/var/www/certbot", "--non-interactive"];
    if (opts.staging) args.push("--staging");
    timeoutMs = 600_000;
  } else {
    args = ["delete", "--cert-name", domain, "--non-interactive"];
  }

  const mounts = action === "delete" ? letsencryptMount : [...letsencryptMount, ...webrootMount];
  const result = await run("docker", ["run", "--rm", ...mounts, CERTBOT_IMAGE, ...args], timeoutMs);
  return {
    ok: result.ok,
    mode: "real",
    domain,
    action,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || (result.ok ? "certbot completed" : "certbot failed"),
  };
}

export async function runCertbotAction(domain: string, action: CertbotAction, opts: { staging?: boolean } = {}): Promise<CertbotActionResult> {
  const resolved = await resolveRoutedDomain(domain);
  if (!resolved) {
    return {
      ok: false,
      mode: "real",
      domain,
      action,
      output: "Domain is not in the routed nginx domain/subdomain list.",
    };
  }

  const result = await containerAction(resolved.domain, resolved.type, action, opts);
  if (result.ok) invalidateCertCaches();
  return result;
}
