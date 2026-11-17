/* eslint-disable security/detect-object-injection -- the keys are fixed column names in this module. */
/* eslint-disable security/detect-non-literal-fs-filename -- paths are Stackport's own transfer directory and a ticket id it generated. */
import crypto, { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { actionRegistry, projectRepoKey } from "../actions/registry";
import { DockerVolumeEngine, type VolumeEngine, type VolumeSource } from "../backup/volumeEngine";
import { importProject, ProjectArchiveError, projectDirs, removeImportedProject } from "../backup/projectArchive";
import { currentVolumeRoots, managedVolumesRoot } from "../deployments/compose/managedVolumes";
import { healthChecker } from "../deployments/health";
import { deployProject, ensureProjectProxyNetwork, getProjectById, stopAndPurgeProject } from "../deployments/operations";
import { DOMAIN_RE } from "../ingress/domainName";
import { listManagedDomains } from "../ingress/managedDomains";
import { writeNginxConfig } from "../ingress/nginx/configWriter";
import { runCertbotAction } from "../ingress/certificates/operations";
import { listProjectDomains, parseContainerPort, parseServiceName, setProjectDomainSsl } from "../ingress/domains";
import { bindProjectToApp, candidatesForRepo, resolveAppRepository, verifyRepositoryAccess } from "../github/binding";
import { GithubAppError } from "../github/app";
import { listCredentials } from "../projects/operations";
import { destroyProject } from "../projects/destroy";
import { sha256OfFile } from "./fileHash";
import { deployRoot as configuredDeployRoot, expectedComposeProjectName } from "../projects/workspace";

/**
 * The target of a move. It hands out a one-time ticket, receives the archive the source pushes (chunk by chunk, each checked), imports it with the same
 * verification as a manual import, starts the project, and either keeps it (commit) or removes everything it created (abort, expiry, failure).
 *
 * The ticket is the only credential the source ever holds for this instance: scoped to one transfer, one hour, and not a standing link between the two.
 */

/** Once chunks are arriving, the ticket is good for this long after the latest one. */
export const TICKET_TTL_MS = 60 * 60 * 1000;
/** Before the first chunk: the source is stopping the project and writing the archive, which takes as long as the data is large. */
export const AWAITING_TTL_MS = 8 * 60 * 60 * 1000;
export const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 4;
const MIN_FREE_BYTES = 1024 ** 3;
const MAX_OPEN_TICKETS = 3;
/** A copy the controller has not asked about for this long was abandoned (the source took the project back by itself): it is removed. */
const SILENCE_MS = 30 * 60 * 1000;

export type TransferState = "awaiting" | "receiving" | "received" | "importing" | "imported" | "starting" | "started" | "committed" | "failed" | "aborted";
/** Transfers that still hold something: files, a project, a slot. A failed one holds only a project, if it got that far, until it is aborted. */
const OPEN: TransferState[] = ["awaiting", "receiving", "received", "importing", "imported", "starting", "started"];

export class TransferError extends Error {
  constructor(readonly status: number, message: string, readonly code = "transfer-error", readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Row {
  id: string; token_hash: string; key_enc: string; controller_instance: string; state: TransferState; name: string; domains_json: string;
  received_bytes: number; next_chunk: number; last_chunk_sha: string | null; size: number | null; sha256: string | null; digest: string | null;
  project_id: number | null; health_endpoint: string | null; auth_json: string | null; warnings_json: string; error: string | null; expires_at: string; created_at: string; updated_at: string;
}

export interface TransferView {
  id: string; state: TransferState; name: string; receivedBytes: number; nextChunk: number; digest: string | null; projectId: number | null;
  warnings: string[]; notCarried: string[]; hostnames: string[]; error: string | null; expiresAt: string;
}

/** What an import records for the steps after it. */
interface ImportNotes { warnings?: string[]; notCarried?: string[]; hostnames?: string[]; /** Hostnames that served TLS on the source: certificates are issued when the move is confirmed. */ ssl?: string[]; branch?: string | null; commit?: string | null }

function notesOf(r: Row): ImportNotes {
  try { return JSON.parse(r.warnings_json) as ImportNotes; } catch { return {}; }
}

/** What this module calls out to, so a test can stand in for Docker. */
export const transferDeps = {
  engine: (): Promise<VolumeEngine | null> => DockerVolumeEngine.create(),
  deploy: (projectId: number, branch?: string | null, commit?: string | null): Promise<{ ok: boolean; output: string }> => deployProject(projectId, "manual", branch ?? null, commit ?? null),
  /** A certificate for a hostname that served TLS on the source, then the TLS route. Needs DNS to point here already: a failure leaves the HTTP route as it is. */
  issueSsl: async (projectId: number, domain: string): Promise<{ ok: boolean; output: string }> => {
    const row = listProjectDomains(projectId).find((d) => d.domain.toLowerCase() === domain.toLowerCase());
    if (!row) return { ok: false, output: `${domain} is no longer a hostname of this project.` };
    if (!row.service || !row.containerPort) return { ok: false, output: `${domain} has no compose service and port to route to.` };
    const cert = await runCertbotAction(row.domain, "issue");
    if (!cert.ok) return { ok: false, output: cert.output };
    setProjectDomainSsl(projectId, row.id, true);
    const applied = await writeNginxConfig();
    return { ok: applied.ok, output: applied.ok ? cert.output : applied.output };
  },
  publish: async (projectId: number): Promise<void> => { await ensureProjectProxyNetwork(projectId); const nginx = await writeNginxConfig(); if (!nginx.ok) logger.warn({ projectId, output: nginx.output }, "transfer.nginx-failed"); },
  purge: async (projectId: number): Promise<void> => { await stopAndPurgeProject(projectId); },
};

const hashToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");
const now = (): string => new Date().toISOString();
const transfersRoot = (): string => path.join(currentVolumeRoots().containerDataRoot, "transfers");
const transferDir = (id: string): string => path.join(transfersRoot(), id);
const archiveFile = (id: string): string => path.join(transferDir(id), "archive.spbackup");
const ID_RE = /^[0-9a-f-]{36}$/;

function row(id: string, db: Database.Database): Row {
  const found = ID_RE.test(id) ? (db.prepare("SELECT * FROM project_transfers_in WHERE id = ?").get(id) as Row | undefined) : undefined;
  if (!found) throw new TransferError(404, "No such transfer.", "not-found");
  return found;
}

function view(r: Row): TransferView {
  const extra = notesOf(r);
  return { id: r.id, state: r.state, name: r.name, receivedBytes: r.received_bytes, nextChunk: r.next_chunk, digest: r.digest, projectId: r.project_id, warnings: extra.warnings ?? [], notCarried: extra.notCarried ?? [], hostnames: extra.hostnames ?? [], error: r.error, expiresAt: r.expires_at };
}

function setState(id: string, state: TransferState, db: Database.Database, fields: Record<string, string | number | null> = {}): void {
  const columns = Object.keys(fields);
  db.prepare(`UPDATE project_transfers_in SET state = ?, updated_at = ?${columns.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`).run(state, now(), ...columns.map((c) => fields[c]), id);
}

/** Free space under the data directory, or null where the platform cannot say. */
function freeBytes(): number | null {
  try { const stats = fs.statfsSync(currentVolumeRoots().containerDataRoot); return Number(stats.bavail) * Number(stats.bsize); } catch { return null; }
}

// ── hostname ────────────────────────────────────────────────────────────────

/** `from` is the hostname on the source this one replaces: where it routed (service, port), whether it served TLS, comes along. */
export interface DomainChoice { domain: string; from?: string; service?: string; containerPort?: number | null }

/** The target's own domain manager: the base domains it manages, for the "new hostname" step. */
export function domainOptions(db: Database.Database = getDatabase()): { bases: { name: string; isDefault: boolean }[]; used: string[] } {
  return {
    bases: listManagedDomains().map((d) => ({ name: d.name, isDefault: d.isDefault })),
    used: (db.prepare("SELECT domain FROM project_domains").all() as { domain: string }[]).map((d) => d.domain),
  };
}

/** Why a hostname cannot be used here, or null. Reserved at import, in the same transaction as the project: another project taking it first fails the import, not the data. */
export function hostnameProblem(domain: string, db: Database.Database = getDatabase()): string | null {
  const name = domain.trim().toLowerCase();
  if (name.length > 253 || !DOMAIN_RE.test(name)) return `"${domain}" is not a valid hostname.`;
  if (db.prepare("SELECT 1 FROM project_domains WHERE lower(domain) = ?").get(name)) return `${name} is already used by another project here.`;
  const bases = listManagedDomains();
  if (bases.length && !bases.some((base) => name === base.name || name.endsWith(`.${base.name}`))) return `${name} is not under a domain this instance manages (${bases.map((b) => b.name).join(", ")}).`;
  return null;
}

// ── how the target reaches GitHub ──────────────────────────────────────────

/** A credential belongs to the instance that holds it: a project that moves here is cloned with THIS instance's token or GitHub App, not the source's. */
export type MoveAuth = { mode: "token"; credentialId: number } | { mode: "app"; installationId?: number; repositoryId?: number } | { mode: "none" };

export interface GithubAuthOptions {
  credentials: { id: number; alias: string; isDefault: boolean }[];
  /** Installations of this instance's GitHub App that can read the repository. */
  app: { installationId: number; repositoryId: number; fullName: string }[];
}

/** What this instance offers a project from `repo`: its GitHub tokens, and its GitHub App if the App can read that repository. */
export function githubAuthOptions(repo: string | null): GithubAuthOptions {
  return {
    credentials: listCredentials("github").map((c) => ({ id: c.id, alias: c.alias, isDefault: c.isDefault })),
    app: repo ? candidatesForRepo(repo).map((r) => ({ installationId: r.installationId, repositoryId: r.repositoryId, fullName: r.fullName })) : [],
  };
}

function parseAuth(value: unknown): MoveAuth | null {
  const a = value as { mode?: unknown; credentialId?: unknown; installationId?: unknown; repositoryId?: unknown } | null;
  if (!a || typeof a !== "object") return null;
  if (a.mode === "none") return { mode: "none" };
  if (a.mode === "token" && Number.isInteger(a.credentialId)) return { mode: "token", credentialId: a.credentialId as number };
  if (a.mode === "app") return { mode: "app", ...(Number.isInteger(a.installationId) ? { installationId: a.installationId as number } : {}), ...(Number.isInteger(a.repositoryId) ? { repositoryId: a.repositoryId as number } : {}) };
  return null;
}

/** Checked before the source is touched: a copy that cannot be cloned would be found out only after the project had been down for the whole transfer. */
async function checkAuth(repo: string, auth: MoveAuth | null): Promise<void> {
  if (!auth) throw new TransferError(400, "Choose how this instance reaches GitHub for this project: one of its tokens, its GitHub App, or none for a public repository.", "auth-required");
  if (auth.mode === "token") {
    if (!listCredentials("github").some((c) => c.id === auth.credentialId)) throw new TransferError(400, "That GitHub token does not exist on this instance.", "bad-request");
  } else if (auth.mode === "app") {
    const found = candidatesForRepo(repo).filter((r) => (auth.installationId === undefined || r.installationId === auth.installationId) && (auth.repositoryId === undefined || r.repositoryId === auth.repositoryId));
    if (found.length === 0) throw new TransferError(409, `This instance's GitHub App cannot read ${repo}. Install it on the repository's owner and connect the account in Settings > GitHub, or choose a token.`, "auth-unavailable");
    if (found.length > 1) throw new TransferError(409, `More than one installation can read ${repo}: choose one.`, "auth-ambiguous");
    try { await verifyRepositoryAccess(resolveAppRepository(found[0].installationId, found[0].repositoryId)); } catch (error) {
      throw new TransferError(409, `This instance's GitHub App could not read ${repo}: ${error instanceof GithubAppError ? error.message : error instanceof Error ? error.message : String(error)}`, "auth-unavailable");
    }
  }
}

function applyAuth(projectId: number, auth: MoveAuth | null, db: Database.Database): void {
  const project = getProjectById(projectId);
  if (!auth || !project?.githubRepo) return;
  if (auth.mode === "token") {
    db.prepare("UPDATE projects SET github_auth_mode = NULL, github_credential_id = ?, credential_id = ?, updated_at = ? WHERE id = ?").run(auth.credentialId, auth.credentialId, now(), projectId);
  } else if (auth.mode === "app") {
    const found = candidatesForRepo(project.githubRepo).filter((r) => (auth.installationId === undefined || r.installationId === auth.installationId) && (auth.repositoryId === undefined || r.repositoryId === auth.repositoryId));
    if (found.length !== 1) throw new Error(`The GitHub App can no longer be matched to ${project.githubRepo}.`);
    bindProjectToApp(projectId, resolveAppRepository(found[0].installationId, found[0].repositoryId));
  }
}

// ── ticket ──────────────────────────────────────────────────────────────────

export interface Ticket { transferId: string; token: string; archiveKey: string; expiresAt: string }

export async function prepareTransfer(input: { controllerInstance: string; name: unknown; domains?: DomainChoice[]; githubRepo?: string | null; auth?: unknown }, db: Database.Database = getDatabase()): Promise<Ticket> {
  purgeExpired(db);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 200) throw new TransferError(400, "Give the project a name of 1 to 200 characters.", "bad-request");
  if (db.prepare("SELECT 1 FROM projects WHERE lower(name) = lower(?)").get(name)) throw new TransferError(409, `A project named "${name}" already exists on this instance.`, "name-exists");
  // Only what is understood is kept: a hostname, the source hostname it replaces, and an explicit route that is a valid service name and port.
  const domains: DomainChoice[] = (input.domains ?? []).map((choice) => ({
    domain: choice.domain,
    ...(typeof choice.from === "string" ? { from: choice.from } : {}),
    ...(parseServiceName(choice.service) ? { service: choice.service } : {}),
    ...(parseContainerPort(choice.containerPort) ? { containerPort: parseContainerPort(choice.containerPort) } : {}),
  }));
  for (const choice of domains) {
    const problem = hostnameProblem(choice.domain, db);
    if (problem) throw new TransferError(409, problem, "hostname-unavailable");
  }
  const auth = parseAuth(input.auth);
  const repo = typeof input.githubRepo === "string" && input.githubRepo.trim() ? input.githubRepo.trim() : null;
  if (repo) await checkAuth(repo, auth);
  const free = freeBytes();
  if (free !== null && free < MIN_FREE_BYTES) throw new TransferError(507, "This instance has less than 1 GB free: there is no room to receive a project.", "no-space");
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM project_transfers_in WHERE state IN (${OPEN.map(() => "?").join(",")})`).get(...OPEN) as { n: number }).n;
  if (open >= MAX_OPEN_TICKETS) throw new TransferError(429, "Too many transfers are open on this instance.", "busy");

  const id = randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const archiveKey = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + AWAITING_TTL_MS).toISOString();
  db.prepare(`INSERT INTO project_transfers_in (id, token_hash, key_enc, controller_instance, state, name, domains_json, auth_json, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, hashToken(token), encryptSecret(archiveKey), input.controllerInstance, "awaiting", name, JSON.stringify(domains), repo && auth ? JSON.stringify(auth) : null, expiresAt, now(), now());
  fs.mkdirSync(transferDir(id), { recursive: true, mode: 0o700 });
  auditLog(`peer:${input.controllerInstance}`, "transfer.prepared", name, "ok", { transferId: id });
  return { transferId: id, token, archiveKey, expiresAt };
}

// ── receiving ───────────────────────────────────────────────────────────────

/** The one place a source (not a paired controller) is let in: by the ticket's token alone. */
export function authorizeTicket(id: string, token: string, db: Database.Database): Row {
  const r = row(id, db);
  const given = Buffer.from(hashToken(token));
  const want = Buffer.from(r.token_hash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new TransferError(401, "Authentication failed.", "unauthenticated");
  if (Date.parse(r.expires_at) < Date.now()) throw new TransferError(410, "This ticket has expired.", "expired");
  return r;
}

export function receiveChunk(id: string, token: string, index: number, sha256: string, bytes: Buffer, db: Database.Database = getDatabase()): { next: number; received: number } {
  const r = authorizeTicket(id, token, db);
  if (r.state !== "awaiting" && r.state !== "receiving") throw new TransferError(409, `This transfer is ${r.state}, not receiving.`, "wrong-state", { state: r.state });
  if (!Number.isInteger(index) || index < 0) throw new TransferError(400, "Invalid chunk number.", "bad-request");
  if (bytes.length === 0 || bytes.length > CHUNK_MAX_BYTES) throw new TransferError(413, "A chunk is 1 byte to 8 MB.", "too-large");
  if (!/^[0-9a-f]{64}$/.test(sha256) || crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) throw new TransferError(422, "The chunk does not match its checksum.", "checksum");
  // A chunk sent again (the answer was lost) is accepted once, as what it was.
  if (index === r.next_chunk - 1 && sha256 === r.last_chunk_sha) return { next: r.next_chunk, received: r.received_bytes };
  if (index !== r.next_chunk) throw new TransferError(409, `Expected chunk ${r.next_chunk}.`, "out-of-order", { next: r.next_chunk });
  if (r.received_bytes + bytes.length > MAX_ARCHIVE_BYTES) throw new TransferError(413, "The archive is larger than this instance accepts.", "too-large");
  if (index === 0) {
    const free = freeBytes();
    if (free !== null && free < MIN_FREE_BYTES) throw new TransferError(507, "This instance has less than 1 GB free.", "no-space");
  }
  const file = archiveFile(id);
  // A crash between the write and the row would leave bytes the row does not know about: cut the file back to what the row says first.
  const fd = fs.openSync(file, fs.existsSync(file) ? "r+" : "w+", 0o600);
  try {
    fs.ftruncateSync(fd, r.received_bytes);
    fs.writeSync(fd, bytes, 0, bytes.length, r.received_bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  setState(id, "receiving", db, { received_bytes: r.received_bytes + bytes.length, next_chunk: index + 1, last_chunk_sha: sha256, expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString() });
  return { next: index + 1, received: r.received_bytes + bytes.length };
}

/** The source says it has sent everything: count, size and the SHA-256 of the whole archive must match what was received. */
export async function completeTransfer(id: string, token: string, declared: { chunks: number; size: number; sha256: string }, db: Database.Database = getDatabase()): Promise<TransferView> {
  const r = authorizeTicket(id, token, db);
  if (r.state === "received") return view(r);
  if (r.state !== "receiving") throw new TransferError(409, `This transfer is ${r.state}.`, "wrong-state", { state: r.state });
  if (declared.chunks !== r.next_chunk || declared.size !== r.received_bytes) throw new TransferError(409, `Received ${r.next_chunk} chunks (${r.received_bytes} bytes), but the source says ${declared.chunks} (${declared.size}).`, "incomplete", { next: r.next_chunk });
  if (!/^[0-9a-f]{64}$/.test(declared.sha256) || (await sha256OfFile(archiveFile(id))) !== declared.sha256) {
    setState(id, "failed", db, { error: "The archive as received does not match the checksum the source computed." });
    removeFiles(id);
    throw new TransferError(422, "The archive as received does not match the checksum the source computed.", "checksum");
  }
  setState(id, "received", db, { size: declared.size, sha256: declared.sha256 });
  return view(row(id, db));
}

// ── importing ───────────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<void>>();
/** For tests, and for a caller that wants to wait: resolves when the background work of this transfer has settled. */
export function settled(id: string): Promise<void> { return inflight.get(id) ?? Promise.resolve(); }

function removeFiles(id: string): void {
  try { fs.rmSync(transferDir(id), { recursive: true, force: true }); } catch { /* swept later */ }
}

function owned(r: Row, controllerInstance: string): void {
  if (r.controller_instance !== controllerInstance) throw new TransferError(404, "No such transfer.", "not-found");
}

export function getTransfer(id: string, controllerInstance: string, db: Database.Database = getDatabase()): TransferView {
  const r = row(id, db);
  owned(r, controllerInstance);
  return view(r);
}

/** The controller says it is still there. A copy nobody has kept alive for a while was abandoned (the source took the project back by itself) and is removed. */
export function keepAlive(id: string, controllerInstance: string, db: Database.Database = getDatabase()): TransferView {
  const r = row(id, db);
  owned(r, controllerInstance);
  if (r.state === "imported" || r.state === "started") db.prepare("UPDATE project_transfers_in SET updated_at = ? WHERE id = ?").run(now(), id);
  return view(row(id, db));
}

/** Imports the archive that was received, with the manual import's verification. Returns at once; the state says how it went. */
export function startImport(id: string, controllerInstance: string, db: Database.Database = getDatabase()): TransferView {
  const r = row(id, db);
  owned(r, controllerInstance);
  if (r.state === "importing" || r.state === "imported") return view(r);
  if (r.state !== "received") throw new TransferError(409, `This transfer is ${r.state}: the archive has not been received completely.`, "wrong-state", { state: r.state });
  const free = freeBytes();
  if (free !== null && r.size !== null && free < r.size * 2) throw new TransferError(507, `Importing needs about twice the archive's size free (${Math.ceil((r.size * 2) / 1024 ** 3)} GB); this instance has ${Math.floor(free / 1024 ** 3)} GB.`, "no-space");
  setState(id, "importing", db);
  const job = (async (): Promise<void> => {
    try {
      const engine = await transferDeps.engine();
      const domains = (JSON.parse(r.domains_json) as DomainChoice[]).map((d) => ({ ...d, useSsl: false }));
      const result = await importProject({ archivePath: archiveFile(id), passphrase: decryptSecret(r.key_enc), name: r.name, domains, engine, requireVerified: true, allowRawNginx: false, db });
      setState(id, "imported", db, { digest: result.digest, project_id: result.projectId, warnings_json: JSON.stringify({ warnings: result.warnings, notCarried: result.notCarried, hostnames: result.hostnames.map((h) => h.domain), ssl: result.sslHostnames, branch: result.deployedBranch, commit: result.deployedCommit } satisfies ImportNotes) });
      auditLog(`peer:${controllerInstance}`, "transfer.imported", r.name, "ok", { transferId: id, projectId: result.projectId });
    } catch (error) {
      const message = error instanceof ProjectArchiveError || error instanceof Error ? error.message : String(error);
      setState(id, "failed", db, { error: message });
      auditLog(`peer:${controllerInstance}`, "transfer.imported", r.name, "fail", { transferId: id, error: message });
    } finally {
      removeFiles(id); // the archive holds every secret of the project: it is not kept once imported or failed
      inflight.delete(id);
    }
  })();
  inflight.set(id, job);
  return view(row(id, db));
}

// ── starting ────────────────────────────────────────────────────────────────

/** Runs the imported project on this instance (a normal deploy), then publishes its routes. The project is the target's own from here: the same code that deploys any project. */
export function startImported(id: string, controllerInstance: string, db: Database.Database = getDatabase()): TransferView {
  const r = row(id, db);
  owned(r, controllerInstance);
  if (r.state === "starting" || r.state === "started") return view(r);
  if (r.state !== "imported" || r.project_id === null) throw new TransferError(409, `This transfer is ${r.state}: nothing has been imported to start.`, "wrong-state", { state: r.state });
  const projectId = r.project_id;
  setState(id, "starting", db);
  const job = (async (): Promise<void> => {
    try {
      // Created paused so nothing deployed it by itself; it runs now, and a paused project gets no health check.
      // The deploy's own health gate probes the public hostname, which does not point at this instance until the user moves its DNS: for a move the gate is
      // "the containers run" (projectHealth). The configured check is put back, and scheduled, once the deploy is over.
      // This instance's own way of reaching GitHub: the source's credentials do not exist here.
      applyAuth(projectId, r.auth_json ? (JSON.parse(r.auth_json) as MoveAuth) : null, db);
      const configured = getProjectById(projectId)?.healthCheckEndpoint ?? null;
      db.prepare("UPDATE project_transfers_in SET health_endpoint = ? WHERE id = ?").run(configured, id);
      db.prepare("UPDATE projects SET paused = 0, health_check_endpoint = NULL, updated_at = ? WHERE id = ?").run(now(), projectId);
      const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
        const record = actionRegistry.tryStart(projectRepoKey(projectId), "deploy", { projectId, triggeredBy: "move" }, async () => {
          try {
            const deployed = await transferDeps.deploy(projectId, notesOf(r).branch ?? null, notesOf(r).commit ?? null);
            resolve({ ok: deployed.ok, output: deployed.output });
            return { ok: deployed.ok, output: deployed.output };
          } catch (error) {
            const output = error instanceof Error ? error.message : String(error);
            resolve({ ok: false, output });
            return { ok: false, output };
          }
        });
        if (!record) resolve({ ok: false, output: "Another action is running on this project." });
      });
      db.prepare("UPDATE projects SET health_check_endpoint = ?, updated_at = ? WHERE id = ?").run(configured, now(), projectId);
      if (!result.ok) { setState(id, "failed", db, { error: `The project did not start: ${result.output.slice(-400)}` }); return; }
      await transferDeps.publish(projectId);
      const started = getProjectById(projectId);
      if (started) healthChecker.schedule(started);
      setState(id, "started", db);
    } catch (error) {
      const saved = (db.prepare("SELECT health_endpoint FROM project_transfers_in WHERE id = ?").get(id) as { health_endpoint: string | null } | undefined)?.health_endpoint ?? null;
      db.prepare("UPDATE projects SET health_check_endpoint = ? WHERE id = ?").run(saved, projectId);
      setState(id, "failed", db, { error: error instanceof Error ? error.message : String(error) });
    } finally { inflight.delete(id); }
  })();
  inflight.set(id, job);
  return view(row(id, db));
}

/** Whether the started project answers: its recorded status, which the health checker keeps current. A project without a health check is up when its deploy succeeded. */
export async function projectHealth(id: string, controllerInstance: string, db: Database.Database = getDatabase()): Promise<{ healthy: boolean; detail: string }> {
  const r = row(id, db);
  owned(r, controllerInstance);
  const project = r.project_id === null ? null : getProjectById(r.project_id);
  if (!project || r.state !== "started") return { healthy: false, detail: r.state === "started" ? "The project no longer exists." : `This transfer is ${r.state}.` };
  const engine = await transferDeps.engine();
  if (!engine) return { healthy: true, detail: "The deploy succeeded (Docker could not be asked about the containers)." };
  const running = await engine.runningContainers(expectedComposeProjectName(project));
  return running.length > 0
    ? { healthy: true, detail: `${running.length} container(s) running.${r.health_endpoint ? " Its HTTP health check runs against the hostname, which answers once its DNS points here." : ""}` }
    : { healthy: false, detail: "No container of the project is running." };
}

// ── ending ──────────────────────────────────────────────────────────────────

/** The user confirmed: the project is this instance's own. Nothing is removed. */
export function commitTransfer(id: string, controllerInstance: string, db: Database.Database = getDatabase()): TransferView {
  const r = row(id, db);
  owned(r, controllerInstance);
  if (r.state === "committed") return view(r);
  if (r.state !== "started") throw new TransferError(409, `This transfer is ${r.state}: only a started project can be confirmed.`, "wrong-state", { state: r.state });
  setState(id, "committed", db);
  removeFiles(id);
  auditLog(`peer:${controllerInstance}`, "transfer.committed", r.name, "ok", { transferId: id, projectId: r.project_id });
  // The project is this instance's own now. Its TLS is the one thing a move could not do before: the certificate needs DNS pointing here, which is what confirming says it does.
  const ssl = notesOf(r).ssl ?? [];
  if (ssl.length && r.project_id !== null) void issueCarriedSsl(id, r.project_id, r.name, ssl, db);
  return view(row(id, db));
}

/** Issues the certificates of a committed move, one hostname after another, and says on the transfer how each went. Never undoes the move. */
export async function issueCarriedSsl(id: string, projectId: number, name: string, domains: string[], db: Database.Database = getDatabase()): Promise<void> {
  const notes: string[] = [];
  for (const domain of domains) {
    try {
      const result = await transferDeps.issueSsl(projectId, domain);
      auditLog("system", "transfer.ssl", `${name}:${domain}`, result.ok ? "ok" : "fail", { transferId: id });
      notes.push(result.ok ? `${domain}: TLS certificate issued and applied.` : `${domain}: no TLS certificate yet (${result.output.split("\n").filter(Boolean).slice(-1)[0] ?? "failed"}). Point its DNS here, then issue it from the project's domain settings.`);
    } catch (error) {
      notes.push(`${domain}: no TLS certificate yet (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  const current = row(id, db);
  const extra = notesOf(current);
  db.prepare("UPDATE project_transfers_in SET warnings_json = ? WHERE id = ?").run(JSON.stringify({ ...extra, warnings: [...(extra.warnings ?? []), ...notes], ssl: [] } satisfies ImportNotes), id);
}

function sourcesOf(project: { id: number; name: string }): VolumeSource[] {
  const roots = currentVolumeRoots();
  return [{ kind: "bind", hostPath: managedVolumesRoot(roots, project.id).host }];
}

/** Removes everything this transfer created: the project, its containers and volumes, its directories, its reserved hostname, its files. Safe to repeat. */
const aborting = new Set<string>();

export async function abortTransfer(id: string, controllerInstance: string | null, db: Database.Database = getDatabase()): Promise<TransferView> {
  const r = row(id, db);
  if (controllerInstance !== null) owned(r, controllerInstance);
  if (r.state === "committed") throw new TransferError(409, "This transfer was confirmed and cannot be aborted: the project is this instance's own.", "wrong-state", { state: r.state });
  if (aborting.has(id)) return view(r);
  aborting.add(id);
  try {
    return await doAbort(id, r, controllerInstance, db);
  } finally { aborting.delete(id); }
}

async function doAbort(id: string, r: Row, controllerInstance: string | null, db: Database.Database): Promise<TransferView> {
  await settled(id).catch(() => undefined);
  // The row as it is now: an import that was still running has just created the project, and that is what has to be removed.
  const projectId = row(id, db).project_id;
  const project = projectId === null ? null : getProjectById(projectId);
  if (project && projectId !== null) {
    const engine: VolumeEngine | null = await transferDeps.engine();
    try { await transferDeps.purge(projectId); } catch { /* the volumes are removed below */ }
    const volumes: VolumeSource[] = sourcesOf(project);
    if (engine) for (const named of await engine.namedVolumes(expectedComposeProjectName(project)).catch(() => [])) volumes.push({ kind: "named", name: named.name });
    const destroyed = await destroyProject(projectId, db);
    if (!destroyed.ok) {
      setState(id, "failed", db, { error: `Could not remove the project: ${destroyed.error}. Abort again once that is fixed.` });
      throw new TransferError(502, `Could not remove the project: ${destroyed.error}`, "abort-incomplete");
    }
    await removeImportedProject(db, projectId, projectDirs({ id: projectId, name: project.name, source_type: project.sourceType }, currentVolumeRoots(), path.resolve(configuredDeployRoot())), { engine, volumes });
    void transferDeps.publish(projectId).catch(() => undefined);
  }
  removeFiles(id);
  setState(id, "aborted", db, { project_id: null });
  auditLog(controllerInstance ? `peer:${controllerInstance}` : "system", "transfer.aborted", r.name, "ok", { transferId: id });
  return view(row(id, db));
}

/** Tickets that ran out before they finished are undone; finished rows are kept for a week, then dropped. */
export function purgeExpired(db: Database.Database = getDatabase()): void {
  const stale = db.prepare(`SELECT id FROM project_transfers_in WHERE (expires_at < ? AND state IN ('awaiting','receiving','received')) OR (state IN ('importing','starting')) OR (state IN ('imported','started','failed') AND updated_at < ?)`).all(now(), new Date(Date.now() - SILENCE_MS).toISOString()) as { id: string }[];
  // importing and starting run in this process: one with no job here was cut short by a restart, and its half-made project goes.
  for (const { id } of stale.filter((s) => !inflight.has(s.id))) void abortTransfer(id, null, db).catch((error: unknown) => logger.error({ error: String(error), transferId: id }, "transfer.purge-failed"));
  db.prepare("DELETE FROM project_transfers_in WHERE state IN ('aborted','committed','failed') AND updated_at < ?").run(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  try {
    for (const entry of fs.readdirSync(transfersRoot())) {
      if (!ID_RE.test(entry)) continue;
      const known = db.prepare("SELECT state FROM project_transfers_in WHERE id = ?").get(entry) as { state: TransferState } | undefined;
      if (!known || !OPEN.includes(known.state)) removeFiles(entry);
    }
  } catch { /* no transfers directory yet */ }
}
