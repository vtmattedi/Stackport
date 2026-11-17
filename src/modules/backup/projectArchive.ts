/* eslint-disable security/detect-non-literal-fs-filename -- paths are Stackport's configured data directories or names it enumerated and validated itself (archive entry names pass isSafeEntryName). */
/* eslint-disable security/detect-object-injection -- keys are fixed column lists in this module or entry names validated by isSafeEntryName. */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { packageVersion } from "../maintenance/version";
import { currentVolumeRoots, managedVolumesRoot, type VolumeRoots } from "../deployments/compose/managedVolumes";
import { DOMAIN_RE } from "../ingress/domainName";
import { sealEnvVariables, tryReadEnvVariables, type EnvVariable, type ProjectEnvFileRow } from "../projects/envFiles";
import { deployRoot as configuredDeployRoot, expectedComposeProjectName } from "../projects/workspace";
import { ArchiveError, ArchiveWriter, isSafeEntryName, readArchive, readEntryBuffer, writeEntryTo } from "./archive";
import { ensureInstanceIdentity } from "./instance";
import { LATEST_SCHEMA_VERSION } from "./manifest";

/**
 * Level 3: one project as a sealed archive (the `SPBACKUP` container), usable by hand and as the payload of a move.
 *
 *   header.json  first, so a reader knows this is a project archive before anything else
 *   files/...    the project's data: `files/volumes/...` (its managed directories) and `files/repo/...` (an uploaded source)
 *   manifest.json last, because the hashes are taken while the files are written, in one pass
 *
 * The manifest carries the project's configuration, its env files with their secret values (the archive is encrypted; the target re-encrypts them under
 * its own keys), and a **content digest**: a SHA-256 over what the project *is* (carried configuration, env values, network-group services, directories, and
 * every file's name, size and hash). The importer recomputes it from what it actually wrote, the database rows and the files on disk, so a failed or
 * partial write cannot pass for a copy.
 */

export const PROJECT_ARCHIVE_FORMAT = 1;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export type ProjectArchiveCode = "not-found" | "not-a-project-archive" | "unsupported" | "name-exists" | "corrupt" | "env-unreadable" | "digest-mismatch" | "invalid" | "unreadable" | "ownership";

export class ProjectArchiveError extends Error {
  constructor(message: string, readonly code: ProjectArchiveCode) {
    super(message);
    this.name = "ProjectArchiveError";
  }
}

/** The project columns an archive carries, in a fixed order (the digest depends on it). Everything else is runtime state, or tied to this instance
 *  (credentials, GitHub App installation, the webhook), and is reported as not carried. */
const CARRIED_COLUMNS = [
  "internal_port", "health_check_endpoint", "health_check_interval_s", "group_name", "source_type", "github_repo", "auto_deploy_branch", "deploy_trigger",
  "paused", "favorite", "compose_file", "available_compose_files", "deploy_health_grace_s", "auto_rollback_unhealthy", "compose_policy_enforced",
  "volumes_managed", "hardened_defaults", "network_group", "ingress_isolated", "github_deploy_on",
] as const;

export interface ProjectContent {
  config: Record<string, unknown>;
  env: { path: string; variables: EnvVariable[] }[];
  /** Services in the project's network group. */
  groupServices: string[];
  /** Directories, relative to the archive's `files/` (so empty ones survive). */
  dirs: string[];
  files: { name: string; size: number; sha256: string }[];
}

export interface FileMeta { mode: number; uid: number; gid: number }

export interface SourceHostname { domain: string; service: string; containerPort: number | null; useSsl: boolean }

export interface ProjectManifest {
  kind: "project";
  format: number;
  createdAt: string;
  stackportVersion: string;
  schemaVersion: number;
  source: { instance: { id: string; name: string }; projectId: number; name: string };
  content: ProjectContent;
  /** SHA-256 over `content`; what an importer must reproduce from what it wrote. */
  digest: string;
  meta: Record<string, FileMeta>;
  hostnames: SourceHostname[];
  /** Raw nginx directives, outside the digest: applied only when the importer allows them. */
  rawNginx: { extraConfig: string | null; extraBlocks: string | null } | null;
  /** Everything that is not in the archive, and why. Omissions are always stated. */
  notCarried: string[];
  skippedSpecialFiles: number;
}

/** Code-unit order: the digest must not depend on the locale or ICU of the machine that computes it. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function contentDigest(content: ProjectContent): string {
  const canonical = {
    config: CARRIED_COLUMNS.map((column) => [column, content.config[column] ?? null]),
    env: [...content.env].sort((a, b) => byCode(a.path, b.path)).map((file) => [file.path, [...file.variables].sort((a, b) => byCode(a.key, b.key)).map((v) => [v.key, v.value])]),
    groupServices: [...content.groupServices].sort(),
    dirs: [...content.dirs].sort(),
    files: [...content.files].sort((a, b) => byCode(a.name, b.name)).map((f) => [f.name, f.size, f.sha256]),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

interface ProjectDirs { volumes: string; repo: string | null }

function projectDirs(project: { id: number; name: string; source_type: string }, roots: VolumeRoots, deployRoot: string): ProjectDirs {
  return {
    volumes: path.resolve(managedVolumesRoot(roots, project.id).container),
    repo: project.source_type === "upload" ? path.join(deployRoot, expectedComposeProjectName(project)) : null,
  };
}

/** Regular files and directories under `root`, as names under `prefix`. Links and special files are skipped and counted. */
interface Found { files: { name: string; source: string }[]; dirs: string[]; skipped: number; unreadable: string[] }

function walk(root: string, prefix: string, found: Found): void {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return;
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") { found.unreadable.push(`${prefix}/${path.relative(root, dir).split(path.sep).join("/")}`); return; }
      throw error;
    }
    for (const dirent of entries) {
      const full = path.join(dir, dirent.name);
      const name = `${prefix}/${path.relative(root, full).split(path.sep).join("/")}`;
      if (dirent.isDirectory()) { found.dirs.push(name); visit(full); }
      else if (dirent.isFile()) found.files.push({ name, source: full });
      else found.skipped += 1;
    }
  };
  visit(root);
}

function sha256Of(file: string): { size: number; sha256: string } {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  let size = 0;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size, sha256: hash.digest("hex") };
}

/** The database part of a project's content: carried columns, env values, network-group services. Used on the source at export and on the target to verify. */
function readDbContent(db: Database.Database, projectId: number): Pick<ProjectContent, "config" | "env" | "groupServices"> {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!row) throw new ProjectArchiveError("The project does not exist.", "not-found");
  const config: Record<string, unknown> = {};
  for (const column of CARRIED_COLUMNS) config[column] = column === "deploy_trigger" && row[column] === "webhook" ? "poller" : (row[column] ?? null);
  const env = (db.prepare("SELECT * FROM project_env_files WHERE project_id = ? ORDER BY relative_path").all(projectId) as ProjectEnvFileRow[]).map((file) => {
    const variables = tryReadEnvVariables(file);
    if (!variables) throw new ProjectArchiveError(`The values of ${file.relative_path} cannot be decrypted with this instance's keys, so they cannot be carried. Fix the key or delete the file first.`, "env-unreadable");
    return { path: file.relative_path, variables };
  });
  const groupServices = (db.prepare("SELECT service FROM network_group_services WHERE project_id = ? ORDER BY service").all(projectId) as { service: string }[]).map((r) => r.service);
  return { config, env, groupServices };
}

export interface ExportProjectOptions {
  projectId: number;
  outPath: string;
  passphrase: string;
  db?: Database.Database;
  roots?: VolumeRoots;
  deployRoot?: string;
  now?: () => Date;
}

/** Writes one project's archive at `outPath`; never leaves a partial file there. The caller decides whether the project is running: a running database's
 *  files copied live are crash-consistent at best, which is why a move stops the project first. */
export function exportProject(options: ExportProjectOptions): ProjectManifest {
  const db = options.db ?? getDatabase();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(options.projectId) as (Record<string, unknown> & { id: number; name: string; source_type: string }) | undefined;
  if (!project) throw new ProjectArchiveError("The project does not exist.", "not-found");
  const roots = options.roots ?? currentVolumeRoots();
  const dirs = projectDirs(project, roots, path.resolve(options.deployRoot ?? configuredDeployRoot()));
  const dbContent = readDbContent(db, project.id);

  const found: Found = { files: [], dirs: [], skipped: 0, unreadable: [] };
  walk(dirs.volumes, "files/volumes", found);
  if (dirs.repo) walk(dirs.repo, "files/repo", found);

  const outPath = path.resolve(options.outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const partial = `${outPath}.partial`;
  fs.rmSync(partial, { force: true });
  const writer = new ArchiveWriter(partial, options.passphrase);
  try {
    writer.addBuffer("header.json", Buffer.from(JSON.stringify({ kind: "project", format: PROJECT_ARCHIVE_FORMAT }), "utf8"));
    const meta: Record<string, FileMeta> = {};
    const files: ProjectContent["files"] = [];
    const metaFor = (name: string, source: string): void => { meta[name] = statMeta(source); };
    let vanished = 0;
    for (const file of found.files) {
      try {
        const written = writer.addFile(file.name, file.source);
        files.push({ name: file.name, ...written });
        metaFor(file.name, file.source);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") { vanished += 1; continue; } // removed since it was listed: a live project's temporary file
        if (code === "EACCES" || code === "EPERM") { found.unreadable.push(file.name); continue; }
        throw error;
      }
    }
    if (found.unreadable.length) {
      const shown = found.unreadable.slice(0, 5).map((name) => name.replace(/^files\//, "")).join(", ");
      throw new ProjectArchiveError(`${found.unreadable.length} path(s) in this project's data cannot be read by Stackport (${shown}${found.unreadable.length > 5 ? ", ..." : ""}). They belong to another user inside a container, such as a database's data directory. Nothing was archived: leaving them out would hide data loss.`, "unreadable");
    }
    for (const [root, name] of [[dirs.volumes, "files/volumes"], [dirs.repo, "files/repo"]] as const) if (root && fs.existsSync(root)) metaFor(name, root);
    for (const dir of found.dirs) {
      const real = dir.startsWith("files/volumes") ? path.join(dirs.volumes, ...dir.slice("files/volumes/".length).split("/")) : path.join(dirs.repo as string, ...dir.slice("files/repo/".length).split("/"));
      metaFor(dir, real);
    }
    const content: ProjectContent = { ...dbContent, dirs: found.dirs.map((d) => d.slice("files/".length)), files: files.map((f) => ({ ...f, name: f.name.slice("files/".length) })) };
    const hostnames = (db.prepare("SELECT domain, service, container_port, use_ssl FROM project_domains WHERE project_id = ? ORDER BY id").all(project.id) as { domain: string; service: string | null; container_port: number | null; use_ssl: number | null }[])
      .map((d) => ({ domain: d.domain, service: d.service ?? "", containerPort: d.container_port, useSsl: d.use_ssl !== 0 }));
    const nginx = { extraConfig: (project["nginx_extra_config"] as string | null) ?? null, extraBlocks: (project["nginx_extra_blocks"] as string | null) ?? null };
    const notCarried = [
      "Docker named volumes (only the project's managed directories are archived)",
      "the project's containers, images and build cache (rebuilt on the next deploy)",
      "TCP exposures (public ports are chosen per instance)",
      "deploy history, logs and metric samples",
      "credentials, the GitHub App installation and the webhook (tied to this instance)",
      "certificates and nginx routes (issued again for the new hostnames)",
      ...(project.source_type === "github" ? ["the Git checkout (cloned again on the next deploy)"] : []),
      ...(project["deploy_trigger"] === "webhook" ? ["the webhook deploy trigger (becomes polling)"] : []),
      ...(vanished ? [`${vanished} file(s) that were removed while the archive was written`] : []),
    ];
    const manifest: ProjectManifest = {
      kind: "project", format: PROJECT_ARCHIVE_FORMAT, createdAt: (options.now ?? (() => new Date()))().toISOString(), stackportVersion: packageVersion(),
      schemaVersion: LATEST_SCHEMA_VERSION,
      source: { instance: ensureInstanceIdentity(db), projectId: project.id, name: project.name },
      content, digest: contentDigest(content), meta, hostnames,
      rawNginx: nginx.extraConfig || nginx.extraBlocks ? nginx : null,
      notCarried, skippedSpecialFiles: found.skipped,
    };
    const body = Buffer.from(JSON.stringify(manifest), "utf8");
    if (body.length > MAX_MANIFEST_BYTES) throw new ProjectArchiveError("The project has too many files for one archive.", "invalid");
    writer.addBuffer("manifest.json", body);
    writer.finish();
    fs.renameSync(partial, outPath);
    return manifest;
  } catch (error) {
    writer.abort();
    throw error;
  }
}

function statMeta(file: string): FileMeta {
  const stat = fs.statSync(file);
  return { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
}

export interface StagedProjectArchive { manifest: ProjectManifest; dir: string }

/** Decrypts into `dir` and checks every file against the manifest, then the manifest against its own digest. Refuses anything inconsistent. */
export function stageProjectArchive(archivePath: string, passphrase: string, dir: string): StagedProjectArchive {
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Map<string, { size: number; sha256: string }>();
  let manifestBuffer: Buffer | null = null;
  let first = true;
  try {
    readArchive(archivePath, passphrase, (entry) => {
      if (first) {
        first = false;
        let header: { kind?: unknown; format?: unknown } = {};
        try { header = entry.name === "header.json" ? JSON.parse(readEntryBuffer(entry, 4096).toString("utf8")) : {}; } catch { /* handled below */ }
        if (header.kind !== "project") throw new ProjectArchiveError("This is not a project archive (an instance backup is restored with `stackport restore`).", "not-a-project-archive");
        if (header.format !== PROJECT_ARCHIVE_FORMAT) throw new ProjectArchiveError(`Project archive format ${String(header.format)} is not supported (this Stackport reads ${PROJECT_ARCHIVE_FORMAT}).`, "unsupported");
        return;
      }
      if (entry.name === "manifest.json") { manifestBuffer = readEntryBuffer(entry, MAX_MANIFEST_BYTES); return; }
      if (!entry.name.startsWith("files/")) throw new ProjectArchiveError(`The archive contains an unexpected entry (${entry.name}).`, "corrupt");
      seen.set(entry.name, writeEntryTo(entry, dir));
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw new ProjectArchiveError(error.message, "corrupt");
    throw error;
  }
  if (!manifestBuffer) throw new ProjectArchiveError("The archive has no manifest.", "corrupt");
  let manifest: ProjectManifest;
  try { manifest = JSON.parse((manifestBuffer as Buffer).toString("utf8")) as ProjectManifest; } catch { throw new ProjectArchiveError("The archive's manifest is not valid JSON.", "corrupt"); }
  if (manifest.kind !== "project" || manifest.format !== PROJECT_ARCHIVE_FORMAT || !Array.isArray(manifest.content?.files) || !Array.isArray(manifest.content?.dirs) || typeof manifest.digest !== "string") {
    throw new ProjectArchiveError("The archive's manifest is incomplete.", "corrupt");
  }
  const c = manifest.content as Partial<ProjectContent>;
  const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");
  const shapeOk = !!c.config && typeof c.config === "object" && Array.isArray(c.env)
    && c.env.every((file) => typeof file?.path === "string" && Array.isArray(file.variables) && file.variables.every((v) => typeof v?.key === "string" && typeof v.value === "string"))
    && isStrings(c.groupServices) && isStrings(c.dirs)
    && (c.files ?? []).every((f) => typeof f?.name === "string" && Number.isSafeInteger(f.size) && /^[0-9a-f]{64}$/.test(String(f.sha256)))
    && !!manifest.meta && typeof manifest.meta === "object" && typeof manifest.source?.name === "string" && Array.isArray(manifest.hostnames) && Array.isArray(manifest.notCarried);
  if (!shapeOk) throw new ProjectArchiveError("The archive's manifest is incomplete.", "corrupt");
  for (const name of [...manifest.content.dirs, ...manifest.content.files.map((f) => f.name)]) {
    if (!isSafeEntryName(name) || !/^(volumes|repo)\//.test(name)) throw new ProjectArchiveError(`The archive lists an unsafe path (${name}).`, "corrupt");
  }
  const declared = new Map(manifest.content.files.map((f) => [`files/${f.name}`, f]));
  for (const [name, want] of declared) {
    const got = seen.get(name);
    if (!got) throw new ProjectArchiveError(`The archive is incomplete: ${name} is missing.`, "corrupt");
    if (got.size !== want.size || got.sha256 !== want.sha256) throw new ProjectArchiveError(`${name} does not match its checksum in the manifest.`, "corrupt");
  }
  for (const name of seen.keys()) if (!declared.has(name)) throw new ProjectArchiveError(`The archive contains ${name}, which its manifest does not list.`, "corrupt");
  if (contentDigest(manifest.content) !== manifest.digest) throw new ProjectArchiveError("The manifest does not match its own digest.", "corrupt");
  return { manifest, dir };
}

export interface ImportProjectOptions {
  archivePath: string;
  passphrase: string;
  db?: Database.Database;
  roots?: VolumeRoots;
  deployRoot?: string;
  /** The name to give the project; the archive's own name otherwise. A name already in use is refused, never merged. */
  name?: string;
  /** Hostnames to attach (no route or certificate is created here). */
  domains?: { domain: string; service?: string; containerPort?: number | null; useSsl?: boolean }[];
  /** Applied as the project's credential for a GitHub source. */
  credentialId?: number | null;
  /** Apply the archive's raw nginx directives. Off for anything that arrives over the control channel. */
  allowRawNginx?: boolean;
  /** Accept that file ownership cannot be restored (this process is not allowed to chown). Off by default: a database refuses to start on a data directory with the wrong owner. */
  allowOwnershipLoss?: boolean;
  /** Where to stage; defaults to a directory beside the project data. */
  stagingParent?: string;
}

export interface ImportProjectResult {
  projectId: number;
  name: string;
  /** The digest the importer recomputed from what it wrote: equal to the manifest's, or the import would have failed. */
  digest: string;
  hostnames: SourceHostname[];
  notCarried: string[];
  warnings: string[];
}


/** Removes everything an import creates: rows and directories. Idempotent, so a retry after a crash finishes the job. */
export function removeImportedProject(db: Database.Database, projectId: number, dirs: ProjectDirs | null): void {
  db.transaction(() => {
    for (const table of ["project_env_files", "project_domains", "tcp_exposures", "network_group_services", "legacy_mount_sources"]) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  })();
  if (!dirs) return; // directories are removed only once this import has claimed them, never a pre-existing one
  forceRemove(dirs.volumes);
  if (dirs.repo) forceRemove(dirs.repo);
}

/** Removes a tree even when restored modes made parts of it read-only. */
function forceRemove(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  } catch { /* a restored mode blocks the delete: open it up and retry */ }
  const open = (dir: string): void => {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) open(path.join(dir, entry.name));
  };
  if (fs.existsSync(root)) open(root);
  fs.rmSync(root, { recursive: true, force: true });
}

/** Creates a new project from an archive, verifies the result against the archive's digest, and undoes everything if anything fails. */
export function importProject(options: ImportProjectOptions): ImportProjectResult {
  const db = options.db ?? getDatabase();
  const roots = options.roots ?? currentVolumeRoots();
  const deployRoot = path.resolve(options.deployRoot ?? configuredDeployRoot());
  const stagingParent = path.resolve(options.stagingParent ?? roots.containerDataRoot);
  fs.mkdirSync(stagingParent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(stagingParent, ".project-import-"));
  let created: { id: number; dirs: ProjectDirs | null } | null = null;
  try {
    const { manifest } = stageProjectArchive(options.archivePath, options.passphrase, staging);
    if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) throw new ProjectArchiveError(`This archive was made by a newer Stackport (schema ${manifest.schemaVersion}; this one understands up to ${LATEST_SCHEMA_VERSION}). Update this instance first.`, "unsupported");
    const name = (options.name ?? manifest.source.name).trim();
    if (!name || name.length > 200) throw new ProjectArchiveError("The project needs a name of 1 to 200 characters.", "invalid");
    if (db.prepare("SELECT 1 FROM projects WHERE lower(name) = lower(?)").get(name)) throw new ProjectArchiveError(`A project named "${name}" already exists here. Choose another name.`, "name-exists");
    for (const domain of options.domains ?? []) if (domain.domain.length > 253 || !DOMAIN_RE.test(domain.domain)) throw new ProjectArchiveError(`"${domain.domain}" is not a valid hostname.`, "invalid");

    const warnings: string[] = [];
    const notCarried = [...manifest.notCarried];
    const cfg = manifest.content.config;
    const now = new Date().toISOString();
    const nginx = options.allowRawNginx ? manifest.rawNginx : null;
    if (manifest.rawNginx && !nginx) notCarried.push("raw nginx directives (not applied on this import)");

    const projectId = db.transaction((): number => {
      const columns = ["name", ...CARRIED_COLUMNS, "credential_id", "github_credential_id", "nginx_extra_config", "nginx_extra_blocks", "created_at", "updated_at"];
      const values = [name, ...CARRIED_COLUMNS.map((c) => cfg[c] ?? null), options.credentialId ?? null, options.credentialId ?? null, nginx?.extraConfig ?? null, nginx?.extraBlocks ?? null, now, now];
      const id = Number(db.prepare(`INSERT INTO projects (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...(values as (string | number | null)[])).lastInsertRowid);
      for (const file of manifest.content.env) {
        const sealed = sealEnvVariables(file.variables);
        db.prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, file.path, sealed.json, sealed.enc, now, now);
      }
      for (const service of manifest.content.groupServices) db.prepare("INSERT INTO network_group_services (project_id, service) VALUES (?,?)").run(id, service);
      for (const domain of options.domains ?? []) {
        db.prepare("INSERT INTO project_domains (project_id, domain, use_ssl, service, container_port, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
          .run(id, domain.domain.toLowerCase(), domain.useSsl === false ? 0 : 1, domain.service ?? "", domain.containerPort ?? null, now, now);
      }
      return id;
    })();
    const project = { id: projectId, name, source_type: String(cfg["source_type"] ?? "github") };
    const dirs = projectDirs(project, roots, deployRoot);
    created = { id: projectId, dirs: null };

    if (fs.existsSync(dirs.volumes) || (dirs.repo && fs.existsSync(dirs.repo))) throw new ProjectArchiveError("The project's data directory already exists on this instance.", "invalid");
    created.dirs = dirs;
    placeFiles(staging, manifest, dirs);

    // Verify what was written, not what was received: re-read the rows and the files from the target.
    const reread: ProjectContent = { ...readDbContent(db, projectId), dirs: [], files: [] };
    const found: Found = { files: [], dirs: [], skipped: 0, unreadable: [] };
    walk(dirs.volumes, "files/volumes", found);
    if (dirs.repo) walk(dirs.repo, "files/repo", found);
    reread.dirs = found.dirs.map((d) => d.slice("files/".length));
    reread.files = found.files.map((f) => ({ name: f.name.slice("files/".length), ...sha256Of(f.source) }));
    const digest = contentDigest(reread);
    if (digest !== manifest.digest) throw new ProjectArchiveError("What was written does not match the archive (digest differs). The import was undone.", "digest-mismatch");
    // Modes and owners are applied after the digest check (the digest does not cover them) and before the import is called a success.
    const lost = applyModes(manifest, dirs, warnings);
    if (lost > 0) {
      if (!options.allowOwnershipLoss) throw new ProjectArchiveError(`File ownership could not be restored for ${lost} path(s): this process is not allowed to chown. A database refuses to start on a data directory with the wrong owner. Run the import as root, or accept the loss explicitly. The import was undone.`, "ownership");
      warnings.push(`File ownership could not be restored for ${lost} path(s) (accepted).`);
    }
    return { projectId, name, digest, hostnames: manifest.hostnames, notCarried, warnings };
  } catch (error) {
    if (created) removeImportedProject(db, created.id, created.dirs);
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function targetPath(dirs: ProjectDirs, name: string): string {
  return name.startsWith("volumes/") ? path.join(dirs.volumes, ...name.slice("volumes/".length).split("/")) : path.join(dirs.repo as string, ...name.slice("repo/".length).split("/"));
}

/** Moves the staged files into place. */
function placeFiles(staging: string, manifest: ProjectManifest, dirs: ProjectDirs): void {
  if (!dirs.repo && [...manifest.content.files.map((f) => f.name), ...manifest.content.dirs].some((name) => name.startsWith("repo/"))) {
    throw new ProjectArchiveError("The archive has uploaded sources for a project that is not an upload.", "corrupt");
  }
  fs.mkdirSync(dirs.volumes, { recursive: true });
  if (dirs.repo) fs.mkdirSync(dirs.repo, { recursive: true });
  for (const dir of manifest.content.dirs) fs.mkdirSync(targetPath(dirs, dir), { recursive: true });
  for (const file of manifest.content.files) {
    const to = targetPath(dirs, file.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const from = path.join(staging, "files", ...file.name.split("/"));
    try { fs.renameSync(from, to); } catch { fs.copyFileSync(from, to); }
  }
}

/** Applies the recorded modes and owners, files first and directories deepest-first (so a restrictive parent does not block its children), the roots last.
 *  Returns how many paths could not be given their owner. A path that already has the right owner counts as restored. */
function applyModes(manifest: ProjectManifest, dirs: ProjectDirs, warnings: string[]): number {
  if (process.platform === "win32") return 0;
  let lost = 0;
  const roots = [["volumes", "files/volumes", dirs.volumes], ["repo", "files/repo", dirs.repo]] as const;
  const targets: { key: string; file: string }[] = [
    ...manifest.content.files.map((f) => ({ key: `files/${f.name}`, file: targetPath(dirs, f.name) })),
    ...[...manifest.content.dirs].sort((a, b) => b.length - a.length).map((d) => ({ key: `files/${d}`, file: targetPath(dirs, d) })),
    ...roots.flatMap(([, key, dir]) => (dir ? [{ key, file: dir }] : [])),
  ];
  for (const { key, file } of targets) {
    const meta = manifest.meta[key];
    if (!meta) continue;
    try { fs.chmodSync(file, meta.mode & 0o7777); } catch { warnings.push(`Could not set the mode of ${key.replace(/^files\//, "")}.`); }
    try { fs.chownSync(file, meta.uid, meta.gid); } catch {
      const now = fs.statSync(file);
      if (now.uid !== meta.uid || now.gid !== meta.gid) lost += 1;
    }
  }
  return lost;
}
