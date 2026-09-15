import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { getDatabase } from "../config/database";
import { pollingCadenceS } from "../config/pollingCadence";
import { SingleFlightCache } from "../utils/singleFlightCache";
import { CERTBOT_WEBROOT_PATH, DOMAIN_RE, getNginxAppConfig, getNginxLayerStatus, getNginxRuntime } from "./nginx/configWriter";

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

function privileged(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { cmd, args };
  }
  return { cmd: "sudo", args: ["-n", cmd, ...args] };
}

function runPrivileged(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  const command = privileged(cmd, args);
  return run(command.cmd, command.args, timeoutMs);
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
// Tries direct (unprivileged) access first, falling back to sudo — mirrors
// configWriter.ts's certificateExists() exactly. Once StackPort runs containerized
// with /etc/letsencrypt bind-mounted in (see docker-compose.system.yml), the
// unprivileged path works directly since fullchain.pem is normally world-readable
// (it's a public certificate, not the private key); sudo remains the fallback for a
// host-native install where the process user isn't in a group with read access.
async function fileExistsDirect(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function checkFileExists(filePath: string): Promise<RunResult> {
  if (getNginxRuntime() === "container") {
    return run("docker", ["exec", "stackport-nginx", "test", "-f", filePath], 12_000);
  }
  if (await fileExistsDirect(filePath)) return { stdout: "", stderr: "", ok: true, notFound: false };
  return runPrivileged("test", ["-f", filePath], 12_000);
}

async function readOpenssl(args: string[]): Promise<RunResult> {
  const direct = await run("openssl", args, 12_000);
  if (direct.ok) return direct;
  if (direct.notFound) return direct; // openssl binary itself missing — sudo won't fix that
  if (getNginxRuntime() === "container") {
    // Read public certificate metadata only; private keys stay root-only.
    return run("docker", ["exec", "stackport", "openssl", ...args], 12_000);
  }
  return runPrivileged("openssl", args, 12_000); // ran but failed (e.g. permission) — retry with sudo
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
const certbotVersionCache = new SingleFlightCache<RunResult>(
  () => runPrivileged("certbot", ["--version"], 12_000),
  null, // startup / explicit refresh only
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

/** Called right after installing certbot from the System page. */
export function invalidateCertbotVersion(): void {
  certbotVersionCache.invalidate();
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
    (getNginxRuntime() === "container" ? containerCertbotVersionCache : certbotVersionCache).get(),
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
    reason: version.ok ? undefined : getNginxRuntime() === "container"
      ? (version.stderr || version.stdout || "Certbot container unavailable").trim()
      : version.notFound ? "certbot not installed" : (version.stderr || version.stdout).trim(),
    emailConfigured: emailConfig.emailConfigured,
    email: emailConfig.email,
    rootPath: "/etc/letsencrypt/live",
    entries,
  };
}

async function realAction(domain: string, type: CertbotDomainType, action: CertbotAction): Promise<CertbotActionResult> {
  let args: string[];
  let timeoutMs = 300_000;

  if (action === "issue") {
    const email = getCertbotEmailConfig().email;
    if (!email) {
      return {
        ok: false,
        mode: "real",
        domain,
        action,
        output: "CERTBOT_EMAIL is required for real certbot issue actions.",
      };
    }
    args = ["--nginx", "-d", domain];
    if (shouldIssueWwwAlias(domain, type)) {
      args.push("-d", `www.${domain}`);
    }
    args.push("--non-interactive", "--agree-tos", "-m", email);
  } else if (action === "renew") {
    args = ["renew", "--cert-name", domain, "--non-interactive"];
    timeoutMs = 600_000;
  } else {
    args = ["delete", "--cert-name", domain, "--non-interactive"];
  }

  const result = await runPrivileged("certbot", args, timeoutMs);
  return {
    ok: result.ok,
    mode: "real",
    domain,
    action,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || (result.ok ? "certbot completed" : "certbot failed"),
  };
}

const CERTBOT_IMAGE = "certbot/certbot";

/** Container-mode certbot: unlike nginx (a long-running service StackPort talks to
 *  via `docker exec`), certbot is inherently a one-shot CLI tool, so there's no
 *  persistent certbot container to keep running — each action is a fresh
 *  `docker run --rm`, using the same docker.sock access StackPort's own container
 *  already has (Phase 1.1), no new privilege grant needed. Uses `--webroot` instead
 *  of the `--nginx` plugin: the plugin needs to directly parse/rewrite a *live* nginx
 *  process's config, which a certbot container has no access to; webroot mode only
 *  needs the shared directory nginx already serves /.well-known/acme-challenge/ from
 *  (see configWriter.ts's acmeChallengeLocation()). Reuses the real host
 *  /etc/letsencrypt directly (not a separate path) so certs already issued by a prior
 *  host-mode certbot stay valid — no migration needed switching modes.
 *  `staging` is intentionally not exposed through the public issue/renew UI — it
 *  exists for verifying the mechanism against Let's Encrypt's staging endpoint
 *  without spending real rate-limit quota. */
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

  const result = getNginxRuntime() === "container"
    ? await containerAction(resolved.domain, resolved.type, action, opts)
    : await realAction(resolved.domain, resolved.type, action);
  if (result.ok) invalidateCertCaches();
  return result;
}
