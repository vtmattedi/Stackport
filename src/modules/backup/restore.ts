/* eslint-disable security/detect-non-literal-fs-filename -- paths are the operator's own CLI arguments, Stackport's configured data directories, or names Stackport enumerated and validated itself (archive entry names pass isSafeEntryName). */
/* eslint-disable security/detect-object-injection -- keys are table and column names read from sqlite_master, entry names validated by isSafeEntryName, or fixed lists in this module. */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../../config/env";
import { runMigrations } from "../../migrations";
import { createKeyring } from "../../shared/crypto";
import { SECRET_COLUMNS } from "../maintenance/encryption/reencryptSecrets";
import { ArchiveError, readArchive, readEntryBuffer, writeEntryTo } from "./archive";
import { SECRET_ENV_KEYS, TABLE_TIERS } from "./classification";
import { INSTANCE_ID_KEY, newInstanceId } from "./instance";
import { LATEST_SCHEMA_VERSION, parseManifest, type BackupManifest } from "./manifest";

export type RestoreMode = "recover" | "clone";

export interface Finding {
  level: "error" | "warn";
  message: string;
}

export interface StagedArchive {
  manifest: BackupManifest;
  env: { secrets: Record<string, string>; host: Record<string, string> };
  dir: string;
}

/** Thrown when an archive must not be applied. Carries every problem found, not just the first. */
export class RestoreRefused extends Error {
  constructor(readonly findings: Finding[]) {
    super(findings.filter((f) => f.level === "error").map((f) => f.message).join(" "));
    this.name = "RestoreRefused";
  }
}

/** What `stackport restore` can safely write into /etc/stackport/secrets.env. The keys Stackport generates are hex. */
const HOST_SAFE_VALUE = /^[A-Za-z0-9._=+,-]+$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;

/** Decrypts the archive into `dir` and checks every entry against the manifest. Any mismatch refuses the archive. */
export function stageArchive(archivePath: string, passphrase: string, dir: string): StagedArchive {
  fs.mkdirSync(dir, { recursive: true });
  let manifest: BackupManifest | null = null;
  const seen = new Map<string, { size: number; sha256: string }>();
  let envBuffer: Buffer | null = null;

  try {
    readArchive(archivePath, passphrase, (entry) => {
      if (!manifest) {
        if (entry.name !== "manifest.json") throw new RestoreRefused([{ level: "error", message: "The archive does not start with its manifest." }]);
        try {
          manifest = parseManifest(readEntryBuffer(entry, MAX_MANIFEST_BYTES));
        } catch (error) {
          throw new RestoreRefused([{ level: "error", message: (error as Error).message }]);
        }
        return;
      }
      if (entry.name === "env.json") {
        envBuffer = readEntryBuffer(entry, MAX_ENV_BYTES);
        seen.set(entry.name, { size: envBuffer.length, sha256: crypto.createHash("sha256").update(envBuffer).digest("hex") });
        return;
      }
      seen.set(entry.name, writeEntryTo(entry, dir));
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw new RestoreRefused([{ level: "error", message: error.message }]);
    throw error;
  }

  const m = manifest as BackupManifest | null;
  if (!m) throw new RestoreRefused([{ level: "error", message: "The archive has no manifest." }]);

  const findings: Finding[] = [];
  const declared = new Map(m.entries.map((entry) => [entry.name, entry]));
  for (const [name, want] of declared) {
    const got = seen.get(name);
    if (!got) findings.push({ level: "error", message: `The archive is incomplete: ${name} is listed in its manifest but missing.` });
    else if (got.size !== want.size || got.sha256 !== want.sha256) findings.push({ level: "error", message: `${name} does not match its checksum in the manifest.` });
  }
  for (const name of seen.keys()) {
    if (!declared.has(name)) findings.push({ level: "error", message: `The archive contains ${name}, which its manifest does not list.` });
  }
  for (const required of ["db.sqlite", "env.json"]) {
    if (!declared.has(required)) findings.push({ level: "error", message: `The archive has no ${required}.` });
  }
  if (findings.length) throw new RestoreRefused(findings);

  let env: StagedArchive["env"];
  try {
    const parsed = JSON.parse((envBuffer as unknown as Buffer).toString("utf8")) as Partial<StagedArchive["env"]>;
    env = { secrets: parsed.secrets ?? {}, host: parsed.host ?? {} };
  } catch {
    throw new RestoreRefused([{ level: "error", message: "The archive's env.json is not valid." }]);
  }
  return { manifest: m, env, dir };
}

function hasTable(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
}

/** Everything that can be checked without touching the target installation. */
export function verifyStaged(staged: StagedArchive, options: { latestSchema?: number } = {}): Finding[] {
  const findings: Finding[] = [];
  const { manifest, env } = staged;
  const latest = options.latestSchema ?? LATEST_SCHEMA_VERSION;

  if (manifest.schemaVersion > latest) {
    findings.push({ level: "error", message: `This archive was made by a newer Stackport (schema ${manifest.schemaVersion}; this one understands up to ${latest}). Update Stackport first.` });
  }
  if (manifest.unclassifiedTables.length) {
    findings.push({ level: "warn", message: `The archive had tables its level rules did not know and left empty: ${manifest.unclassifiedTables.join(", ")}.` });
  }

  const db = new Database(path.join(staged.dir, "db.sqlite"), { readonly: true });
  try {
    const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      findings.push({ level: "error", message: "The database inside the archive fails its integrity check." });
      return findings;
    }
    if ((db.pragma("foreign_key_check") as unknown[]).length) {
      findings.push({ level: "error", message: "The database inside the archive has broken references between tables." });
    }
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version !== manifest.schemaVersion) {
      findings.push({ level: "error", message: `The database schema (${version}) does not match the manifest (${manifest.schemaVersion}).` });
    }

    // A level must not hold more than it declares: a level-1 archive with project rows is a mislabelled copy.
    if (manifest.level === 1) {
      for (const [table, tier] of Object.entries(TABLE_TIERS)) {
        if (tier === "l1" || !hasTable(db, table)) continue;
        const rows = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
        if (rows > 0) findings.push({ level: "error", message: `A level-1 archive must not contain ${table}, but it has ${rows} rows.` });
      }
    }

    // Secrets must decrypt with the keys the archive carries, or restoring it would produce a healthy-looking install that cannot use its credentials.
    const jwt = env.secrets["JWT_SECRET"];
    if (!jwt) {
      findings.push({ level: "error", message: "The archive carries no JWT_SECRET, so its stored secrets cannot be verified." });
    } else {
      const ring = createKeyring({
        jwtSecret: jwt,
        encryptionKey: env.secrets["ENCRYPTION_KEY"] || undefined,
        previousKeys: (env.secrets["ENCRYPTION_KEY_PREVIOUS"] ?? "").split(",").map((key) => key.trim()).filter(Boolean),
      });
      for (const column of SECRET_COLUMNS) {
        if (!hasTable(db, column.table) || !columnsOf(db, column.table).has(column.column)) continue;
        const rows = db.prepare(`SELECT "${column.idColumn}" AS id, "${column.column}" AS value FROM "${column.table}" WHERE "${column.column}" IS NOT NULL AND "${column.column}" <> ''`).all() as { id: unknown; value: string }[];
        for (const row of rows) {
          try {
            ring.decrypt(row.value);
          } catch {
            findings.push({ level: "error", message: `A stored secret (${column.table}.${column.column} #${String(row.id)}) cannot be decrypted with the archive's keys.` });
          }
        }
      }
    }

    // The host adopts these into secrets.env with sed, so only a plain character set is safe to hand over.
    for (const key of SECRET_ENV_KEYS) {
      const value = env.secrets[key];
      if (value !== undefined && !HOST_SAFE_VALUE.test(value)) {
        findings.push({ level: "error", message: `${key} in the archive contains characters that cannot be written to the host's secrets file safely (allowed: letters, digits and . _ - = +).` });
      }
    }

    const admin = db.prepare("SELECT value FROM app_meta WHERE key = 'admin_password_hash'").get() as { value: string } | undefined;
    if (!admin?.value) findings.push({ level: "warn", message: "The archive holds no administrator password hash; after restoring you must use `stackport admin-recovery`." });
  } finally {
    db.close();
  }
  return findings;
}

/** What `clone` changes so a copy cannot act as, or compete with, the original. Returns a line per change made. */
export function applyCloneTransforms(db: Database.Database): string[] {
  const done: string[] = [];
  db.pragma("foreign_keys = OFF");
  const run = (table: string, sql: string, label: string): void => {
    if (!hasTable(db, table)) return;
    const changes = db.prepare(sql).run().changes;
    if (changes > 0) done.push(`${label} (${changes})`);
  };

  const newId = newInstanceId();
  db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(INSTANCE_ID_KEY, newId);
  done.push(`new instance id ${newId}`);
  run("app_meta", "DELETE FROM app_meta WHERE key = 'status_stream_instance'", "cleared the live-status instance name");
  run("app_meta", "UPDATE app_meta SET value = '0' WHERE key = 'status_stream_enabled' AND value <> '0'", "turned the live-status stream off");
  run("api_tokens", "DELETE FROM api_tokens", "removed API tokens");
  run("auth_tokens", "DELETE FROM auth_tokens", "ended all sessions");
  for (const table of ["github_app_repositories", "github_app_installations", "github_app"]) {
    run(table, `DELETE FROM ${table}`, `removed the GitHub App registration (${table})`);
  }
  run("github_poller_config", "UPDATE github_poller_config SET enabled = 0 WHERE enabled <> 0", "turned the GitHub poller off");
  run("notification_config", "UPDATE notification_config SET enabled = 0 WHERE enabled <> 0", "turned email notifications off");
  run("push_config", "UPDATE push_config SET enabled = 0 WHERE enabled <> 0", "turned web push off");
  run("webhooks", "UPDATE webhooks SET enabled = 0 WHERE enabled <> 0", "disabled webhook scripts");
  // The original keeps its domain and certificates; a clone that kept claiming them would compete for both.
  run("app_meta", "UPDATE app_meta SET value = '0' WHERE key = 'nginx_app_enabled' AND value <> '0'", "turned the public Stackport domain off");
  run("app_meta", "DELETE FROM app_meta WHERE key IN ('nginx_app_domain', 'app_update_credential_id')", "cleared the Stackport domain and the self-update credential");
  run("vps_monitored_vms", "DELETE FROM vps_monitored_vms", "stopped monitoring the original's VMs");

  if (hasTable(db, "projects")) {
    const columns = columnsOf(db, "projects");
    const clears = ["auto_deploy_branch", "hook_public_id", "hook_secret_enc", "github_hook_id", "hook_status", "hook_last_delivery_at", "github_auth_mode", "github_installation_id", "github_repository_id", "github_deploy_on", "github_pending_ci_sha", "github_pending_ci_at", "pending_deploy_sha"].filter((c) => columns.has(c));
    const sets = ["paused = 1", "health_check_interval_s = 0", ...clears.map((c) => `${c} = NULL`)];
    run("projects", `UPDATE projects SET ${sets.join(", ")}`, "paused every project and detached it from GitHub hooks and automatic deploys");
  }
  return done;
}

function movePath(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export interface CurrentInstallation {
  exists: boolean;
  instanceId: string | null;
  instanceName: string | null;
  projects: number;
}

/** What a restore would replace, read without changing anything. */
export function describeInstallation(sqlitePath: string): CurrentInstallation {
  if (!fs.existsSync(sqlitePath)) return { exists: false, instanceId: null, instanceName: null, projects: 0 };
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const meta = (key: string): string | null => (hasTable(db, "app_meta") ? ((db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null) : null);
    return {
      exists: true,
      instanceId: meta(INSTANCE_ID_KEY),
      instanceName: meta("instance_name"),
      projects: hasTable(db, "projects") ? (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n : 0,
    };
  } finally {
    db.close();
  }
}

export interface RestoreOptions {
  archivePath: string;
  passphrase: string;
  mode: RestoreMode;
  sqlitePath?: string;
  scriptsDir?: string;
  deployRoot?: string;
  /** Where the secrets for the host to adopt are written (mode 0600). */
  envOutPath?: string;
  now?: () => Date;
}

export interface RestoreResult {
  mode: RestoreMode;
  manifest: BackupManifest;
  warnings: string[];
  actions: string[];
  /** The previous installation's database and replaced directories, kept so the attempt can be undone by hand. */
  preRestoreDir: string | null;
  envOutPath: string;
  /** Secrets in the archive that differ from this process's: the host must adopt them before Stackport starts. */
  secretsToAdopt: string[];
  instanceId: string;
}

/**
 * Replaces this installation with the archive's content. Offline: nothing else may hold the
 * database open. Everything is decrypted, checked and migrated in a staging directory first;
 * the live files are only moved aside (not deleted) after that, and moved back if any step fails.
 */
export function restoreBackup(options: RestoreOptions): RestoreResult {
  const sqlitePath = path.resolve(options.sqlitePath ?? config.sqlitePath);
  const scriptsDir = path.resolve(options.scriptsDir ?? config.scriptsDir);
  const deployRoot = path.resolve(options.deployRoot ?? config.deployRoot);
  const dataDir = path.dirname(sqlitePath);
  const now = options.now ?? (() => new Date());
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const envOutPath = path.resolve(options.envOutPath ?? path.join(dataDir, ".restore-secrets.env"));
  const staging = path.join(dataDir, `.restore-staging-${stamp}`);

  const undo: (() => void)[] = [];
  try {
    // A handoff left by an earlier attempt belongs to a different archive; never let the host adopt it.
    fs.rmSync(envOutPath, { force: true });
    const staged = stageArchive(options.archivePath, options.passphrase, staging);
    const findings = verifyStaged(staged);
    if (findings.some((f) => f.level === "error")) throw new RestoreRefused(findings);
    const warnings = findings.map((f) => f.message);
    const actions: string[] = [];

    // Bring an older archive up to this release's schema, and apply the clone rules, on the staged copy only.
    const stagedDbPath = path.join(staging, "db.sqlite");
    const stagedDb = new Database(stagedDbPath);
    try {
      stagedDb.pragma("foreign_keys = ON");
      const before = stagedDb.pragma("user_version", { simple: true }) as number;
      runMigrations(stagedDb);
      if (before < LATEST_SCHEMA_VERSION) actions.push(`migrated the database from schema ${before} to ${LATEST_SCHEMA_VERSION}`);
      if (options.mode === "clone") actions.push(...applyCloneTransforms(stagedDb));
      const check = stagedDb.pragma("integrity_check") as { integrity_check: string }[];
      if (check[0]?.integrity_check !== "ok" || (stagedDb.pragma("foreign_key_check") as unknown[]).length) {
        throw new RestoreRefused([{ level: "error", message: "The restored database failed its checks after migration." }]);
      }
      stagedDb.pragma("journal_mode = DELETE");
    } finally {
      stagedDb.close();
    }
    const instanceId = (() => {
      const db = new Database(stagedDbPath, { readonly: true });
      try { return (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(INSTANCE_ID_KEY) as { value: string }).value; } finally { db.close(); }
    })();

    // Swap. Previous files are moved to preRestoreDir, never deleted.
    const preRestoreDir = path.join(dataDir, "backups", `pre-restore-${stamp}`);
    fs.mkdirSync(preRestoreDir, { recursive: true });
    const aside = (target: string, label: string): void => {
      if (!fs.existsSync(target)) return;
      const kept = path.join(preRestoreDir, label);
      movePath(target, kept);
      undo.push(() => movePath(kept, target));
    };
    for (const suffix of ["", "-wal", "-shm"]) aside(`${sqlitePath}${suffix}`, `stackport.sqlite${suffix}`);
    movePath(stagedDbPath, sqlitePath);
    undo.push(() => movePath(sqlitePath, stagedDbPath));
    actions.push("replaced the database");

    const fileRoots = new Map<string, string>(); // staged dir -> live dir
    if (fs.existsSync(path.join(staging, "files", "scripts"))) {
      fileRoots.set(path.join(staging, "files", "scripts"), scriptsDir);
    } else if (fs.existsSync(scriptsDir)) {
      // The archive has no scripts, so the restored webhook rows reference none: the host's old ones must not stay runnable.
      aside(scriptsDir, `files-${path.basename(scriptsDir)}`);
      fs.mkdirSync(scriptsDir, { recursive: true });
      undo.push(() => fs.rmSync(scriptsDir, { recursive: true, force: true }));
      actions.push("set aside the host's webhook scripts (the archive has none)");
    }
    const stagedRepos = path.join(staging, "files", "repos");
    if (fs.existsSync(stagedRepos)) {
      for (const name of fs.readdirSync(stagedRepos)) fileRoots.set(path.join(stagedRepos, name), path.join(deployRoot, name));
    }
    if (fs.existsSync(deployRoot)) {
      // Only uploaded sources travel in an archive; project folders already on this host are left where they are.
      const stale = fs.readdirSync(deployRoot).filter((name) => !fs.existsSync(path.join(stagedRepos, name)));
      if (stale.length) warnings.push(`Project folders already on this host were left in place and are not described by the archive: ${stale.slice(0, 10).join(", ")}${stale.length > 10 ? ", …" : ""}.`);
    }
    for (const [from, to] of fileRoots) {
      aside(to, `files-${path.relative(dataDir, to).split(path.sep).join("_") || path.basename(to)}`);
      movePath(from, to);
      undo.push(() => movePath(to, from));
      actions.push(`restored ${path.relative(dataDir, to) || to}`);
    }

    // The secrets the host must adopt so the restored ciphertext still decrypts.
    const secretsToAdopt = SECRET_ENV_KEYS.filter((key) => (staged.env.secrets[key] ?? "") !== (process.env[key] ?? ""));
    fs.mkdirSync(path.dirname(envOutPath), { recursive: true });
    // KEY=VALUE lines, one per secret the archive carries: the host merges them into secrets.env and deletes this file.
    const lines = SECRET_ENV_KEYS.filter((key) => staged.env.secrets[key]).map((key) => `${key}=${staged.env.secrets[key]}`);
    fs.writeFileSync(envOutPath, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
    undo.push(() => fs.rmSync(envOutPath, { force: true }));

    return { mode: options.mode, manifest: staged.manifest, warnings, actions, preRestoreDir, envOutPath, secretsToAdopt, instanceId };
  } catch (error) {
    for (const step of undo.reverse()) {
      try { step(); } catch { /* best effort: the moved-aside copy is still in preRestoreDir */ }
    }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Authenticates and fully checks an archive without touching this installation. */
export function verifyArchive(archivePath: string, passphrase: string, scratchRoot: string): { manifest: BackupManifest; findings: Finding[] } {
  const dir = path.join(scratchRoot, `.verify-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const staged = stageArchive(archivePath, passphrase, dir);
    return { manifest: staged.manifest, findings: verifyStaged(staged) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
