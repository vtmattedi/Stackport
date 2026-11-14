/* eslint-disable security/detect-non-literal-fs-filename -- paths are the operator's own CLI arguments, Stackport's configured data directories, or names Stackport enumerated and validated itself (archive entry names pass isSafeEntryName). */
/* eslint-disable security/detect-object-injection -- keys are table and column names read from sqlite_master, entry names validated by isSafeEntryName, or fixed lists in this module. */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../../config/env";
import { getDatabase } from "../../config/database";
import { packageVersion } from "../maintenance/version";
import { expectedComposeProjectName } from "../projects/workspace";
import { ArchiveWriter } from "./archive";
import { HOST_ENV_KEYS, META_KEYS, SECRET_ENV_KEYS, TABLE_TIERS, tierIncluded, type BackupLevel } from "./classification";
import { ensureInstanceIdentity } from "./instance";
import { LATEST_SCHEMA_VERSION, MANIFEST_FORMAT, type BackupManifest, type ManifestComponent, type ManifestEntry } from "./manifest";

export interface ScrubReport {
  tables: Record<string, { kept: number; dropped: number }>;
  /** Tables the classification does not know: emptied, and a reason for a test failure. */
  unclassified: string[];
  droppedMetaKeys: string[];
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Empties everything the level may not contain, then VACUUMs so dropped rows do not linger in free pages. */
export function scrubDatabase(db: Database.Database, level: BackupLevel): ScrubReport {
  const report: ScrubReport = { tables: {}, unclassified: [], droppedMetaKeys: [] };
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    for (const table of tables) {
      const tier = TABLE_TIERS[table];
      if (tier === undefined) report.unclassified.push(table);
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;
      if (table === "app_meta" && tierIncluded(tier, level)) {
        const marks = META_KEYS.map(() => "?").join(",");
        report.droppedMetaKeys = (db.prepare(`SELECT key FROM app_meta WHERE key NOT IN (${marks}) ORDER BY key`).all(...META_KEYS) as { key: string }[]).map((row) => row.key);
        db.prepare(`DELETE FROM app_meta WHERE key NOT IN (${marks})`).run(...META_KEYS);
      } else if (!tierIncluded(tier, level)) {
        db.exec(`DELETE FROM ${quote(table)}`);
      }
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;
      report.tables[table] = { kept: after, dropped: before - after };
    }
  })();
  db.exec("VACUUM");
  return report;
}

function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

interface FileSource { name: string; source: string; size: number }

/** Regular files under `root` as `<prefix>/<relative path>`. Links and special files are skipped and counted. */
function listFiles(root: string, prefix: string, skipped: { count: number }): FileSource[] {
  const found: FileSource[] = [];
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        found.push({ name: `${prefix}/${relative}`, source: full, size: fs.statSync(full).size });
      } else skipped.count += 1;
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root);
  return found;
}

export interface CreateBackupOptions {
  level: BackupLevel;
  outPath: string;
  passphrase: string;
  db?: Database.Database;
  env?: NodeJS.ProcessEnv;
  scriptsDir?: string;
  deployRoot?: string;
  now?: () => Date;
}

/** Writes an encrypted archive at `level` and returns what it contains. Never leaves a partial file at `outPath`. */
export function createBackup(options: CreateBackupOptions): BackupManifest {
  const { level, outPath, passphrase } = options;
  const source = options.db ?? getDatabase();
  const env = options.env ?? process.env;
  const scriptsDir = path.resolve(options.scriptsDir ?? config.scriptsDir);
  const deployRoot = path.resolve(options.deployRoot ?? config.deployRoot);
  const now = (options.now ?? (() => new Date()))();
  const instance = ensureInstanceIdentity(source);

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(path.resolve(outPath)), ".backup-staging-"));
  let writer: ArchiveWriter | null = null;
  try {
    const dbFile = path.join(staging, "db.sqlite");
    // A consistent snapshot even while the app is writing; the live database is never copied file-wise.
    source.prepare("VACUUM INTO ?").run(dbFile);
    const snapshot = new Database(dbFile);
    let report: ScrubReport;
    let schemaVersion: number;
    let projectsForFiles: { id: number; name: string }[] = [];
    try {
      if (level >= 2) {
        projectsForFiles = snapshot.prepare("SELECT id, name FROM projects WHERE source_type = 'upload' ORDER BY id").all() as { id: number; name: string }[];
      }
      report = scrubDatabase(snapshot, level);
      schemaVersion = snapshot.pragma("user_version", { simple: true }) as number;
    } finally {
      snapshot.close();
    }

    const envFile = {
      secrets: Object.fromEntries(SECRET_ENV_KEYS.flatMap((key) => (env[key] ? [[key, env[key]]] : []))),
      host: Object.fromEntries(HOST_ENV_KEYS.flatMap((key) => (env[key] ? [[key, env[key]]] : []))),
    };
    const envBuffer = Buffer.from(JSON.stringify(envFile, null, 2), "utf8");

    const skipped = { count: 0 };
    const files: FileSource[] = [...listFiles(scriptsDir, "files/scripts", skipped)];
    if (level >= 2) {
      for (const project of projectsForFiles) {
        files.push(...listFiles(path.join(deployRoot, expectedComposeProjectName(project)), `files/repos/${expectedComposeProjectName(project)}`, skipped));
      }
    }

    const entries: ManifestEntry[] = [
      { name: "db.sqlite", size: fs.statSync(dbFile).size, sha256: sha256File(dbFile) },
      { name: "env.json", size: envBuffer.length, sha256: crypto.createHash("sha256").update(envBuffer).digest("hex") },
      ...files.map((file) => ({ name: file.name, size: file.size, sha256: sha256File(file.source) })),
    ];

    const components: ManifestComponent[] = [
      { id: "settings", included: true, description: "Instance settings, administrator identity (password hash only), credentials, integrations and global domains" },
      { id: "encryption-keys", included: true, description: "The keys that decrypt the stored secrets (inside this encrypted archive only)" },
      { id: "webhook-scripts", included: true, description: `Webhook scripts (${files.filter((f) => f.name.startsWith("files/scripts/")).length} files)` },
      level >= 2
        ? { id: "projects", included: true, description: "Project records, source and deployment configuration, Compose snapshots, managed .env files (with secret values), domains, routes and health checks" }
        : { id: "projects", included: false, description: "Project records and configuration", reason: "Not part of level 1." },
      level >= 2
        ? { id: "project-uploads", included: true, description: `Files uploaded for manually uploaded projects (${projectsForFiles.length} projects)` }
        : { id: "project-uploads", included: false, description: "Uploaded project files", reason: "Not part of level 1." },
      { id: "project-data", included: false, description: "Databases, volumes, uploaded user files and broker state of the workloads", reason: "Only level 3 (not yet available) backs up workload data. This archive cannot recover application data." },
      { id: "git-checkouts", included: false, description: "Checkouts of GitHub-sourced projects", reason: "Cloned again on the next deploy." },
      { id: "certificates", included: false, description: "Let's Encrypt certificates and account", reason: "Issued again for the domains on the new host." },
      { id: "nginx-config", included: false, description: "Generated nginx configuration", reason: "Regenerated from the restored settings." },
      { id: "runtime-state", included: false, description: "Sessions, action history, metric samples, logs, delivery history and queues", reason: "Runtime state, never part of a backup." },
    ];

    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      createdAt: now.toISOString(),
      stackportVersion: packageVersion(),
      schemaVersion,
      level,
      instance,
      host: envFile.host,
      components,
      entries,
      tables: Object.fromEntries(Object.entries(report.tables).map(([name, counts]) => [name, counts.kept])),
      unclassifiedTables: report.unclassified,
      droppedMetaKeys: report.droppedMetaKeys,
      skippedSpecialFiles: skipped.count,
    };
    if (schemaVersion > LATEST_SCHEMA_VERSION) throw new Error(`The database schema (${schemaVersion}) is newer than this code knows (${LATEST_SCHEMA_VERSION}).`);

    const partial = `${path.resolve(outPath)}.partial`;
    fs.rmSync(partial, { force: true });
    writer = new ArchiveWriter(partial, passphrase);
    writer.addBuffer("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    writer.addFile("db.sqlite", dbFile);
    writer.addBuffer("env.json", envBuffer);
    for (const file of files) writer.addFile(file.name, file.source);
    writer.finish();
    writer = null;
    fs.renameSync(partial, path.resolve(outPath));
    return manifest;
  } catch (error) {
    writer?.abort();
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
