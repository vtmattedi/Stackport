/* eslint-disable security/detect-non-literal-fs-filename -- paths are Stackport's own data directory and names it generated. */
import crypto, { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { actionRegistry, projectRepoKey } from "../actions/registry";
import { healthChecker } from "../deployments/health";
import { composeProject, getProjectById, stopProject } from "../deployments/operations";
import { currentVolumeRoots } from "../deployments/compose/managedVolumes";
import { expectedComposeProjectName } from "../projects/workspace";
import { packageVersion } from "../maintenance/version";
import { ArchiveWriter } from "./archive";
import { createBackup } from "./export";
import { ensureInstanceIdentity } from "./instance";
import { LATEST_SCHEMA_VERSION } from "./manifest";
import { exportProject, type SourceHostname } from "./projectArchive";
import { DockerVolumeEngine, type VolumeEngine } from "./volumeEngine";

/**
 * A full backup: this instance's settings and secrets (level 1) and every project with its data (level 3), in ONE sealed file that another Stackport can
 * restore from its dashboard. Inside it, `full.json` comes first and says what the parts are; each part is itself a sealed archive made with the same passphrase,
 * so a part can be checked and used on its own.
 *
 * Projects are copied one at a time: each is stopped (automation paused), archived with its volumes verified, and started again, so the downtime of a project is
 * the time its own copy takes. The projects stopped are recorded as they are stopped, so a restart in the middle gives them back (`reconcileFullBackups`).
 */

export const FULL_FORMAT = 1;
export const FULL_MANIFEST = "full.json";
export const INSTANCE_PART = "parts/instance.spbackup";

export interface FullPart { name: string; size: number; sha256: string }
/** How the source reached GitHub for a project: the instance backup carries the credentials and the App's installations under their ids, so the binding is restored by id. */
export interface FullProjectAuth { credentialId: number | null; githubCredentialId: number | null; mode: string | null; installationId: number | null; repositoryId: number | null }
export interface FullProject extends FullPart {
  id: number; projectName: string; wasRunning: boolean; paused: boolean; digest: string; hostnames: SourceHostname[]; auth: FullProjectAuth;
}
export interface FullManifest {
  kind: "full"; format: number; createdAt: string; stackportVersion: string; schemaVersion: number;
  source: { instance: { id: string; name: string } };
  instance: FullPart;
  projects: FullProject[];
  notCarried: string[];
}

export type FullState = "running" | "done" | "failed";
export interface FullStep { at: string; text: string }
export interface FullView { id: string; state: FullState; steps: FullStep[]; file: string | null; size: number | null; error: string | null; createdAt: string }

interface Row { id: string; state: FullState; steps_json: string; quiesced_json: string; file: string | null; size: number | null; error: string | null; created_at: string; updated_at: string }
interface Original { wasRunning: boolean; paused: boolean }

/** What this module calls out to, so a test can stand in for Docker. */
export const fullDeps = {
  engine: (): Promise<VolumeEngine | null> => DockerVolumeEngine.create(),
  stop: (id: number): Promise<{ ok: boolean; output: string }> => stopProject(id),
  start: (id: number): Promise<{ ok: boolean; output: string }> => composeProject(id),
};

const now = (): string => new Date().toISOString();
export const backupsDir = (): string => path.join(currentVolumeRoots().containerDataRoot, "backups");
const workDir = (id: string): string => path.join(backupsDir(), `.full-${id}`);
const ID_RE = /^[0-9a-f-]{36}$/;
const KEEP_MS = 24 * 60 * 60 * 1000;
/** Jobs this process is running: a row marked running that is not here was cut short by a restart. */
const inFlight = new Set<string>();

function row(id: string, db: Database.Database): Row | null {
  return ID_RE.test(id) ? ((db.prepare("SELECT * FROM full_backups WHERE id = ?").get(id) as Row | undefined) ?? null) : null;
}

function view(r: Row): FullView {
  return { id: r.id, state: r.state, steps: JSON.parse(r.steps_json) as FullStep[], file: r.file, size: r.size, error: r.error, createdAt: r.created_at };
}

function step(id: string, text: string, db: Database.Database): void {
  const r = row(id, db);
  if (!r) return;
  const steps = [...(JSON.parse(r.steps_json) as FullStep[]), { at: now(), text }];
  db.prepare("UPDATE full_backups SET steps_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(steps), now(), id);
}

const sha256File = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function sha256Stream(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

/** Gives a project back as it was recorded. */
async function giveBack(projectId: number, original: Original, engine: VolumeEngine | null, db: Database.Database): Promise<string | null> {
  const project = getProjectById(projectId);
  if (!project) return null;
  try {
    if (original.wasRunning) {
      const started = await fullDeps.start(projectId);
      if (!started.ok) return `${project.name} could not be started again: ${started.output.slice(-300)}`;
      if (engine && !(await engine.runningContainers(expectedComposeProjectName(project))).length) return `${project.name} was started again but has no running containers.`;
    }
    db.prepare("UPDATE projects SET paused = ?, updated_at = ? WHERE id = ?").run(original.paused ? 1 : 0, now(), projectId);
    const restored = getProjectById(projectId);
    if (restored) healthChecker.schedule(restored);
    return null;
  } catch (error) {
    return `${project.name} could not be restored: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function setQuiesced(id: string, quiesced: Record<string, Original>, db: Database.Database): void {
  db.prepare("UPDATE full_backups SET quiesced_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(quiesced), now(), id);
}

function authOf(projectId: number, db: Database.Database): FullProjectAuth {
  const r = db.prepare("SELECT credential_id, github_credential_id, github_auth_mode, github_installation_id, github_repository_id FROM projects WHERE id = ?").get(projectId) as
    { credential_id: number | null; github_credential_id: number | null; github_auth_mode: string | null; github_installation_id: number | null; github_repository_id: number | null };
  return { credentialId: r.credential_id, githubCredentialId: r.github_credential_id, mode: r.github_auth_mode, installationId: r.github_installation_id, repositoryId: r.github_repository_id };
}

export class FullBackupError extends Error {
  constructor(readonly status: number, message: string, readonly code = "full-backup") { super(message); }
}

/** Starts a full backup and returns at once; the job reports through `getFullBackup`. The passphrase is held in memory for the job only. */
export async function startFullBackup(passphrase: string, db: Database.Database = getDatabase()): Promise<FullView> {
  if (typeof passphrase !== "string" || passphrase.length < 12) throw new FullBackupError(400, "Use a passphrase of at least 12 characters.", "bad-passphrase");
  if (db.prepare("SELECT 1 FROM full_backups WHERE state = 'running'").get()) throw new FullBackupError(409, "A full backup is already running.", "busy");
  const engine = await fullDeps.engine();
  const projects = db.prepare("SELECT id FROM projects ORDER BY id").all() as { id: number }[];
  if (!engine && projects.length) throw new FullBackupError(503, "A full backup needs Docker (the privileged helper reads each project's data); Docker is not reachable from here.", "needs-helper");
  const id = randomUUID();
  db.prepare("INSERT INTO full_backups (id, state, created_at, updated_at) VALUES (?, 'running', ?, ?)").run(id, now(), now());
  auditLog("system", "full-backup.started", id, "ok", { projects: projects.length });
  inFlight.add(id);
  void run(id, passphrase, engine, db).catch((error: unknown) => logger.error({ id, error: error instanceof Error ? error.message : String(error) }, "full-backup.crashed"));
  return view(row(id, db) as Row);
}

async function run(id: string, passphrase: string, engine: VolumeEngine | null, db: Database.Database): Promise<void> {
  const dir = workDir(id);
  const quiesced: Record<string, Original> = {};
  const problems: string[] = [];
  const final = path.join(backupsDir(), `stackport-full-${now().replace(/[:.]/g, "-").slice(0, 19)}-${id.slice(0, 8)}.spbackup`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    step(id, "Backing up this instance's settings and secrets", db);
    const instancePath = path.join(dir, "instance.spbackup");
    createBackup({ level: 1, outPath: instancePath, passphrase, db });
    const instance: FullPart = { name: INSTANCE_PART, size: fs.statSync(instancePath).size, sha256: sha256File(instancePath) };

    const projects: FullProject[] = [];
    const rows = db.prepare("SELECT id, name FROM projects ORDER BY id").all() as { id: number; name: string }[];
    for (const [index, entry] of rows.entries()) {
      const project = getProjectById(entry.id);
      if (!project) continue;
      const partPath = path.join(dir, `project-${project.id}.spbackup`);
      const original: Original = { wasRunning: engine ? (await engine.runningContainers(expectedComposeProjectName(project))).length > 0 : false, paused: project.paused };
      step(id, `Project ${index + 1} of ${rows.length}: ${project.name}${original.wasRunning ? " (stopped while it is copied)" : ""}`, db);
      // The project's action slot is held while it is copied, so nothing deploys, restarts or deletes it meanwhile.
      const manifest = await new Promise<Awaited<ReturnType<typeof exportProject>>>((resolve, reject) => {
        const slot = actionRegistry.tryStart(projectRepoKey(project.id), "backup", { projectId: project.id, triggeredBy: "backup" }, async () => {
          try {
            quiesced[String(project.id)] = original;
            setQuiesced(id, quiesced, db); // recorded before anything is touched: a restart now gives the project back
            db.prepare("UPDATE projects SET paused = 1, updated_at = ? WHERE id = ?").run(now(), project.id);
            healthChecker.unschedule(project.id);
            if (original.wasRunning) {
              const stopped = await fullDeps.stop(project.id);
              if (!stopped.ok) throw new Error(`${project.name} could not be stopped: ${stopped.output.slice(-300)}`);
              if (engine && (await engine.runningContainers(expectedComposeProjectName(project))).length) throw new Error(`${project.name} still has running containers after it was stopped.`);
            }
            resolve(await exportProject({ projectId: project.id, outPath: partPath, passphrase, engine, db }));
            return { ok: true, output: "backed up" };
          } catch (error) {
            reject(error);
            return { ok: false, output: error instanceof Error ? error.message : String(error) };
          } finally {
            const problem = await giveBack(project.id, original, engine, db);
            delete quiesced[String(project.id)];
            setQuiesced(id, quiesced, db);
            if (problem) problems.push(problem);
          }
        });
        if (!slot) reject(new Error(`${project.name} is busy with another action; try again when it has finished.`));
      });
      projects.push({
        name: `parts/project-${project.id}.spbackup`, size: fs.statSync(partPath).size, sha256: await sha256Stream(partPath),
        id: project.id, projectName: project.name, wasRunning: original.wasRunning, paused: original.paused, digest: manifest.digest, hostnames: manifest.hostnames, auth: authOf(project.id, db),
      });
    }
    if (problems.length) throw new Error(problems.join(" "));

    step(id, "Sealing the backup into one file", db);
    const identity = ensureInstanceIdentity(db);
    const manifest: FullManifest = {
      kind: "full", format: FULL_FORMAT, createdAt: now(), stackportVersion: packageVersion(), schemaVersion: LATEST_SCHEMA_VERSION,
      source: { instance: identity }, instance, projects,
      notCarried: [
        "containers, images and build cache (rebuilt when each project is started)",
        "certificates (issued again for the hostnames when DNS points at the new host)",
        "deploy history, logs and metric samples",
        "TCP exposures (public ports are chosen per instance)",
      ],
    };
    const writer = new ArchiveWriter(final, passphrase);
    try {
      writer.addBuffer(FULL_MANIFEST, Buffer.from(JSON.stringify(manifest), "utf8"));
      await writer.addFileAsync(INSTANCE_PART, instancePath);
      for (const part of projects) await writer.addFileAsync(part.name, path.join(dir, path.basename(part.name)));
      writer.finish();
    } catch (error) { writer.abort(); throw error; }
    fs.chmodSync(final, 0o600);
    db.prepare("UPDATE full_backups SET state = 'done', file = ?, size = ?, updated_at = ? WHERE id = ?").run(path.basename(final), fs.statSync(final).size, now(), id);
    step(id, `Done: ${projects.length} project${projects.length === 1 ? "" : "s"} and the instance in one file. Download it now; it is kept for 24 hours.`, db);
    auditLog("system", "full-backup.finished", id, "ok", { projects: projects.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Anything still stopped is given back before the failure is reported.
    for (const [projectId, original] of Object.entries(quiesced)) { const problem = await giveBack(Number(projectId), original, engine, db); if (problem) problems.push(problem); }
    db.prepare("UPDATE full_backups SET state = 'failed', error = ?, quiesced_json = '{}', updated_at = ? WHERE id = ?").run(message, now(), id);
    auditLog("system", "full-backup.finished", id, "fail", { error: message });
  } finally {
    inFlight.delete(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function getFullBackup(id: string, db: Database.Database = getDatabase()): FullView | null {
  const r = row(id, db);
  return r ? view(r) : null;
}

export function listFullBackups(db: Database.Database = getDatabase()): FullView[] {
  return (db.prepare("SELECT * FROM full_backups ORDER BY created_at DESC LIMIT 10").all() as Row[]).map(view);
}

/** The finished file of a backup, for download; null when it is not (or no longer) there. */
export function fullBackupFile(id: string, db: Database.Database = getDatabase()): { path: string; name: string; size: number } | null {
  const r = row(id, db);
  if (!r || r.state !== "done" || !r.file || r.file !== path.basename(r.file)) return null;
  const file = path.join(backupsDir(), r.file);
  try { return { path: file, name: r.file, size: fs.statSync(file).size }; } catch { return null; }
}

export function deleteFullBackup(id: string, db: Database.Database = getDatabase()): boolean {
  const r = row(id, db);
  if (!r || r.state === "running") return false;
  if (r.file && r.file === path.basename(r.file)) fs.rmSync(path.join(backupsDir(), r.file), { force: true });
  db.prepare("DELETE FROM full_backups WHERE id = ?").run(id);
  return true;
}

/** A restart in the middle of a backup: the projects it had stopped are given back, and the job is marked failed. Old files are removed (they hold every secret). */
export async function reconcileFullBackups(db: Database.Database = getDatabase()): Promise<void> {
  for (const r of db.prepare("SELECT * FROM full_backups WHERE state = 'running'").all() as Row[]) {
    if (inFlight.has(r.id)) continue;
    const problems: string[] = [];
    const engine = await fullDeps.engine().catch(() => null);
    for (const [projectId, original] of Object.entries(JSON.parse(r.quiesced_json) as Record<string, Original>)) {
      const problem = await giveBack(Number(projectId), original, engine, db);
      if (problem) problems.push(problem);
    }
    db.prepare("UPDATE full_backups SET state = 'failed', error = ?, quiesced_json = '{}', updated_at = ? WHERE id = ?")
      .run(`Interrupted by a restart.${problems.length ? ` ${problems.join(" ")}` : " Every project was given back."}`, now(), r.id);
    fs.rmSync(workDir(r.id), { recursive: true, force: true });
    auditLog("system", "full-backup.interrupted", r.id, problems.length ? "fail" : "ok", { problems });
  }
  for (const r of db.prepare("SELECT * FROM full_backups WHERE state != 'running'").all() as Row[]) {
    if (Date.parse(r.updated_at) < Date.now() - KEEP_MS) deleteFullBackup(r.id, db);
  }
}
