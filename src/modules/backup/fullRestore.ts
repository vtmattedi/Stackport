/* eslint-disable security/detect-non-literal-fs-filename -- paths are Stackport's own data directory and names it generated or validated. */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type Database from "better-sqlite3";
import { config } from "../../config/env";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { FULL_BACKUP_MAX_UPLOAD_BYTES } from "../../shared/backupLimits";
import { currentVolumeRoots } from "../deployments/compose/managedVolumes";
import { deployProject, getProjectById } from "../deployments/operations";
import { healthChecker } from "../deployments/health";
import { runCertbotAction } from "../ingress/certificates/operations";
import { listProjectDomains, setProjectDomainSsl } from "../ingress/domains";
import { writeNginxConfig } from "../ingress/nginx/configWriter";
import { currentImage, updaterRunArgs } from "../maintenance/selfUpdate";
import { ArchiveError, readArchiveAsync, readEntryBufferAsync, writeEntryToAsync } from "./archive";
import { FULL_FORMAT, FULL_MANIFEST, INSTANCE_PART, type FullManifest, type FullProject } from "./fullBackup";
import { INSTANCE_NAME_KEY } from "./instance";
import { importProject, type ImportProjectResult } from "./projectArchive";
import { describeInstallation, verifyArchive, type CurrentInstallation, type Finding, type RestoreMode } from "./restore";
import { DockerVolumeEngine, type VolumeEngine } from "./volumeEngine";

/**
 * Restoring a full backup from the dashboard. Three phases, each of which survives what the next one does to this process:
 *
 *   1. upload and inspect (`receiveUpload`, `inspectFull`): the file is received, opened with the passphrase, its parts checked against `full.json`, and a preview made.
 *      Nothing is changed. The parts are kept in the data directory (outside the database a restore replaces).
 *   2. restore the instance (`confirmFull`): the same `stackport restore` an operator runs, started in a detached container exactly as the dashboard's update is,
 *      because it stops this app, replaces its database and adopts the archive's encryption keys into the host's secrets.env. The passphrase goes in a file the host
 *      script reads once and removes. A plan of the projects to bring back is written first.
 *   3. bring the projects back (`finishProjects`): this instance, now the restored one, imports each project's archive (verified against its digest), starts the ones
 *      that were running, and issues certificates for the hostnames that served TLS. It needs the passphrase again: it is never kept.
 */

const exec = promisify(execFile);
const RESTORER = "stackport-restorer";
const MAX_MANIFEST = 4 * 1024 * 1024;

export class RestoreError extends Error {
  constructor(readonly status: number, message: string, readonly code = "restore") { super(message); }
}

export const restoreDir = (): string => path.join(currentVolumeRoots().containerDataRoot, "restore");
const uploadFile = (): string => path.join(restoreDir(), "upload.spbackup");
const partsDir = (): string => path.join(restoreDir(), "parts");
const planFile = (): string => path.join(restoreDir(), "plan.json");
const passphraseFile = (): string => path.join(restoreDir(), ".passphrase");
const hostRestoreDir = (): string => path.posix.join(currentVolumeRoots().hostDataRoot.split(path.sep).join("/"), "restore");

/** What this module calls out to, so a test can stand in for Docker and the host. */
export const restoreDeps = {
  engine: (): Promise<VolumeEngine | null> => DockerVolumeEngine.create(),
  /** Starts `stackport restore` on the host, detached. Resolves once it has started, not when it is done. */
  launchHostRestore: async (hostFile: string, mode: RestoreMode, hostPassphraseFile: string): Promise<void> => {
    await exec("docker", ["rm", "--force", RESTORER]).catch(() => undefined);
    await exec("docker", updaterRunArgs(await currentImage(), RESTORER, ["/usr/local/bin/stackport", "restore", hostFile, "--mode", mode, "--yes"], { detach: true, env: [`STACKPORT_BACKUP_PASSPHRASE_FILE=${hostPassphraseFile}`] }), { timeout: 60_000 });
  },
  hostRestoreStatus: async (): Promise<{ state: "none" | "running" | "done" | "failed"; output: string }> => {
    try {
      const info = JSON.parse((await exec("docker", ["inspect", RESTORER])).stdout)[0] as { State: { Running: boolean; ExitCode: number } };
      const logs = await exec("docker", ["logs", "--tail", "200", RESTORER]);
      const output = [logs.stdout, logs.stderr].filter(Boolean).join("\n").slice(-20_000);
      return { state: info.State.Running ? "running" : info.State.ExitCode === 0 ? "done" : "failed", output };
    } catch { return { state: "none", output: "" }; }
  },
  issueSsl: async (projectId: number, domain: string): Promise<{ ok: boolean; output: string }> => {
    const row = listProjectDomains(projectId).find((d) => d.domain.toLowerCase() === domain.toLowerCase());
    if (!row?.service || !row.containerPort) return { ok: false, output: `${domain} has no compose service and port to route to.` };
    const cert = await runCertbotAction(row.domain, "issue");
    if (!cert.ok) return { ok: false, output: cert.output };
    setProjectDomainSsl(projectId, row.id, true);
    const applied = await writeNginxConfig();
    return { ok: applied.ok, output: applied.ok ? cert.output : applied.output };
  },
  deploy: (projectId: number, branch: string | null, commit: string | null): Promise<{ ok: boolean; output: string }> => deployProject(projectId, "manual", branch, commit),
  publish: async (): Promise<void> => {
    const result = await writeNginxConfig();
    if (!result.ok) throw new Error(result.output || "The restored routes could not be applied.");
  },
};

// ── 1. upload and inspect ──────────────────────────────────────────────────

/** Receives the file from the request body. One request: a restore that is cut short starts again. */
export async function receiveUpload(body: NodeJS.ReadableStream, declaredSize: number | null, maxBytes = FULL_BACKUP_MAX_UPLOAD_BYTES): Promise<{ size: number }> {
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > maxBytes)) throw new RestoreError(413, "The file's size is not acceptable.", "too-large");
  if (fs.existsSync(planFile())) throw new RestoreError(409, "A restore is already in progress on this instance: finish or cancel it first.", "busy");
  fs.rmSync(restoreDir(), { recursive: true, force: true });
  fs.mkdirSync(restoreDir(), { recursive: true, mode: 0o700 });
  const out = fs.createWriteStream(uploadFile(), { flags: "wx", mode: 0o600 });
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      body.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { reject(new RestoreError(413, "The file is larger than this instance accepts.", "too-large")); return; }
        if (!out.write(chunk)) { body.pause(); out.once("drain", () => body.resume()); }
      });
      body.on("end", () => out.end(() => resolve()));
      body.on("error", reject);
      body.on("aborted", () => reject(new RestoreError(400, "The upload was cut short.", "aborted")));
      out.on("error", reject);
    });
  } catch (error) {
    out.destroy();
    fs.rmSync(restoreDir(), { recursive: true, force: true });
    throw error;
  }
  if (size === 0) { fs.rmSync(restoreDir(), { recursive: true, force: true }); throw new RestoreError(400, "The file is empty.", "empty"); }
  return { size };
}

export interface RestorePreview {
  source: { instance: { id: string; name: string }; createdAt: string; stackportVersion: string };
  projects: { id: number; name: string; size: number; wasRunning: boolean; hostnames: string[] }[];
  instanceSize: number;
  findings: Finding[];
  current: CurrentInstallation & { name: string | null };
  notCarried: string[];
  /** The name to type to confirm: this instance's own. */
  confirmName: string;
}

function validManifest(value: unknown): value is FullManifest {
  const m = value as FullManifest;
  const part = (p: unknown): boolean => !!p && typeof (p as { name?: unknown }).name === "string" && Number.isSafeInteger((p as { size: number }).size) && /^[0-9a-f]{64}$/.test(String((p as { sha256: unknown }).sha256));
  return !!m && m.kind === "full" && m.format === FULL_FORMAT && typeof m.createdAt === "string" && !!m.source?.instance && part(m.instance) && m.instance.name === INSTANCE_PART
    && Array.isArray(m.projects) && m.projects.every((p) => part(p) && p.name === `parts/project-${p.id}.spbackup` && Number.isInteger(p.id) && typeof p.projectName === "string" && p.projectName.length > 0 && p.projectName.length <= 200 && Array.isArray(p.hostnames))
    && new Set(m.projects.map((p) => p.id)).size === m.projects.length && Array.isArray(m.notCarried);
}

/** Opens the uploaded file, checks every part against `full.json`, and describes what a restore would do. Changes nothing but the files it extracts. */
export async function inspectFull(passphrase: string, db: Database.Database = getDatabase()): Promise<RestorePreview> {
  if (!fs.existsSync(uploadFile())) throw new RestoreError(409, "Upload a full backup first.", "no-upload");
  if (typeof passphrase !== "string" || !passphrase) throw new RestoreError(400, "The passphrase is required.", "bad-passphrase");
  fs.rmSync(partsDir(), { recursive: true, force: true });
  fs.mkdirSync(partsDir(), { recursive: true, mode: 0o700 });
  let manifest: FullManifest | null = null;
  const seen = new Map<string, { size: number; sha256: string }>();
  try {
    await readArchiveAsync(uploadFile(), passphrase, async (entry) => {
      if (!manifest) {
        if (entry.name !== FULL_MANIFEST) throw new RestoreError(400, "This is not a full backup (it does not start with full.json). An instance backup made by `stackport backup` is restored with `stackport restore` on the host.", "not-full");
        let parsed: unknown;
        try { parsed = JSON.parse((await readEntryBufferAsync(entry, MAX_MANIFEST)).toString("utf8")); } catch { throw new RestoreError(400, "The backup's manifest is damaged.", "corrupt"); }
        if (!validManifest(parsed)) throw new RestoreError(400, "The backup's manifest is incomplete or from a newer Stackport.", "corrupt");
        manifest = parsed;
        return;
      }
      const wanted = [manifest.instance, ...manifest.projects].find((p) => p.name === entry.name);
      if (!wanted) throw new RestoreError(400, `The backup holds an entry its manifest does not list (${entry.name}).`, "corrupt");
      seen.set(entry.name, await writeEntryToAsync(entry, partsDir()));
    });
  } catch (error) {
    fs.rmSync(partsDir(), { recursive: true, force: true });
    if (error instanceof RestoreError) throw error;
    if (error instanceof ArchiveError) throw new RestoreError(400, error.message, "archive");
    throw error;
  }
  const full = manifest as FullManifest | null;
  if (!full) throw new RestoreError(400, "The backup is empty.", "corrupt");
  for (const part of [full.instance, ...full.projects]) {
    const got = seen.get(part.name);
    if (!got || got.size !== part.size || got.sha256 !== part.sha256) { fs.rmSync(partsDir(), { recursive: true, force: true }); throw new RestoreError(400, `${part.name} is missing or differs from what the manifest recorded: the backup is damaged.`, "corrupt"); }
  }
  // The instance part is a complete level-1 archive: it is verified the way `stackport restore` verifies one (checksums, schema, every stored secret decryptable).
  const checked = verifyArchive(path.join(partsDir(), "parts", "instance.spbackup"), passphrase, restoreDir());
  if (checked.findings.some((f) => f.level === "error")) { fs.rmSync(partsDir(), { recursive: true, force: true }); throw new RestoreError(400, checked.findings.filter((f) => f.level === "error").map((f) => f.message).join(" "), "unverified"); }
  // Keep the sealed upload until completion so a refreshed preview can be
  // verified again with its passphrase; the dashboard offers "Show it".
  fs.writeFileSync(path.join(restoreDir(), "inspected.json"), JSON.stringify({ manifest: full, inspectedAt: new Date().toISOString() }), { mode: 0o600 });
  const name = (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(INSTANCE_NAME_KEY) as { value: string } | undefined)?.value ?? null;
  return {
    source: { instance: full.source.instance, createdAt: full.createdAt, stackportVersion: full.stackportVersion },
    projects: full.projects.map((p) => ({ id: p.id, name: p.projectName, size: p.size, wasRunning: p.wasRunning, hostnames: p.hostnames.map((h) => h.domain) })),
    instanceSize: full.instance.size,
    findings: checked.findings,
    current: { ...describeInstallation(config.sqlitePath), name },
    notCarried: full.notCarried,
    confirmName: name ?? "this instance",
  };
}

// ── 2. restore the instance ────────────────────────────────────────────────

export interface RestorePlan {
  mode: RestoreMode;
  startedAt: string;
  source: { id: string; name: string };
  projects: (FullProject & { file: string; imported?: ImportProjectResult; completed?: boolean })[];
}

/** Keep verified imports across a failed deploy or process restart, without importing their data twice. */
function savePlan(plan: RestorePlan): void {
  const staged = `${planFile()}.tmp`;
  fs.writeFileSync(staged, JSON.stringify(plan), { mode: 0o600 });
  fs.renameSync(staged, planFile());
}

function readInspected(): FullManifest {
  try { const value = JSON.parse(fs.readFileSync(path.join(restoreDir(), "inspected.json"), "utf8")) as { manifest: unknown }; if (validManifest(value.manifest)) return value.manifest; } catch { /* below */ }
  throw new RestoreError(409, "Inspect an uploaded backup first.", "not-inspected");
}

/** Replaces this instance with the backup's. The host does it: this process is stopped and replaced, and comes back as the restored instance. */
export async function confirmFull(input: { passphrase: string; mode: RestoreMode; confirm: string }, db: Database.Database = getDatabase()): Promise<{ launched: true }> {
  if (input.mode !== "recover" && input.mode !== "clone") throw new RestoreError(400, "Choose recover (the same instance, on a new host) or clone (a new instance).", "bad-mode");
  const manifest = readInspected();
  const name = (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(INSTANCE_NAME_KEY) as { value: string } | undefined)?.value ?? "this instance";
  if (input.confirm !== name) throw new RestoreError(400, `Type the name of this instance (${name}) to confirm that it will be replaced.`, "not-confirmed");
  if (typeof input.passphrase !== "string" || !input.passphrase) throw new RestoreError(400, "The passphrase is required.", "bad-passphrase");
  if (fs.existsSync(planFile())) throw new RestoreError(409, "A restore is already in progress.", "busy");

  const plan: RestorePlan = { mode: input.mode, startedAt: new Date().toISOString(), source: manifest.source.instance, projects: manifest.projects.map((p) => ({ ...p, file: path.basename(p.name) })) };
  savePlan(plan);
  fs.writeFileSync(passphraseFile(), input.passphrase, { mode: 0o600 });
  try {
    await restoreDeps.launchHostRestore(path.posix.join(hostRestoreDir(), "parts", "parts", "instance.spbackup"), input.mode, path.posix.join(hostRestoreDir(), ".passphrase"));
  } catch (error) {
    fs.rmSync(planFile(), { force: true });
    fs.rmSync(passphraseFile(), { force: true });
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "full-restore.launch-failed");
    throw new RestoreError(500, "The host restore could not be started. Check that Docker is reachable and the host CLI is installed.", "launch");
  }
  auditLog("system", "full-restore.started", manifest.source.instance.name, "ok", { mode: input.mode, projects: manifest.projects.length });
  return { launched: true };
}

// ── 3. bring the projects back ─────────────────────────────────────────────

export interface ProjectOutcome { id: number; name: string; state: "waiting" | "importing" | "starting" | "done" | "failed"; message: string | null }
export interface FinishView { running: boolean; mode: RestoreMode; outcomes: ProjectOutcome[]; finished: boolean }

let job: { running: boolean; outcomes: ProjectOutcome[]; finished: boolean; mode: RestoreMode } | null = null;

export function readPlan(): RestorePlan | null {
  try { return JSON.parse(fs.readFileSync(planFile(), "utf8")) as RestorePlan; } catch { return null; }
}

/** Where a restore stands: the host's part (while this instance is being replaced) and the projects still to bring back. */
export async function restoreStatus(): Promise<{ plan: RestorePlan | null; host: Awaited<ReturnType<typeof restoreDeps.hostRestoreStatus>>; finish: FinishView | null; preview: boolean }> {
  const plan = readPlan();
  const preview = !plan && fs.existsSync(path.join(restoreDir(), "inspected.json"));
  return { plan, host: plan ? await restoreDeps.hostRestoreStatus() : { state: "none", output: "" }, finish: job, preview };
}

/** Gives up on a restore that has not replaced anything yet, or whose projects the admin no longer wants brought back. */
export function cancelRestore(): void {
  if (job?.running) throw new RestoreError(409, "Projects are being restored; wait for it to finish.", "busy");
  fs.rmSync(restoreDir(), { recursive: true, force: true });
  job = null;
}

/** Imports the projects of the plan, one after another; a failure in one does not stop the others. */
export async function finishProjects(passphrase: string, db: Database.Database = getDatabase()): Promise<FinishView> {
  const plan = readPlan();
  if (!plan) throw new RestoreError(409, "There is no restore waiting for its projects.", "no-plan");
  if (job?.running) throw new RestoreError(409, "Projects are already being restored.", "busy");
  if (typeof passphrase !== "string" || !passphrase) throw new RestoreError(400, "The passphrase is required.", "bad-passphrase");
  const engine = await restoreDeps.engine();
  if (!engine && plan.projects.length) throw new RestoreError(503, "Restoring project data needs Docker; Docker is not reachable from here.", "needs-helper");
  job = { running: true, finished: false, mode: plan.mode, outcomes: plan.projects.map((p) => ({ id: p.id, name: p.projectName, state: "waiting", message: null })) };
  const current = job;
  void (async () => {
    const sslToIssue: { projectId: number; domain: string }[] = [];
    for (const project of plan.projects) {
      const outcome = current.outcomes.find((o) => o.id === project.id) as ProjectOutcome;
      const file = path.join(partsDir(), "parts", project.file);
      try {
        outcome.state = "importing";
        if (!project.imported && !fs.existsSync(file)) throw new Error("The project's archive is missing; it has not been restored.");
        const result = project.imported ?? await importProject({
          archivePath: file, passphrase, name: project.projectName, engine, requireVerified: true, allowRawNginx: true, db,
          // The same hostnames as on the source, without TLS until a certificate exists here.
          domains: project.hostnames.map((h) => ({ domain: h.domain, from: h.domain, useSsl: false })),
        });
        if (!project.imported) {
          project.imported = result;
          savePlan(plan);
        }
        if (getProjectById(result.projectId)?.name !== project.projectName) throw new Error("The previously imported project is missing or was renamed; it cannot be resumed automatically.");
        for (const domain of result.sslHostnames) sslToIssue.push({ projectId: result.projectId, domain });
        if (project.completed) { outcome.state = "done"; outcome.message = "Already restored."; continue; }
        applyAuth(result.projectId, project, db);
        const notes = [...result.warnings];
        // A recovered project that was running is started again; a clone, and anything that was stopped or paused, stays as it is.
        if (plan.mode === "recover" && project.wasRunning && !project.paused) {
          outcome.state = "starting";
          db.prepare("UPDATE projects SET paused = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), result.projectId);
          const deployed = await restoreDeps.deploy(result.projectId, result.deployedBranch, result.deployedCommit).catch((error: unknown) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));
          if (!deployed.ok) {
            db.prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(result.projectId);
            throw new Error(`It did not start: ${deployed.output.slice(-300)}. Its verified data is kept; retry restoring the projects.`);
          }
          const started = getProjectById(result.projectId);
          if (started && deployed.ok) healthChecker.schedule(started);
        } else {
          db.prepare("UPDATE projects SET paused = 1 WHERE id = ?").run(result.projectId);
          notes.push(plan.mode === "clone" ? "Restored paused (a clone)." : "Restored paused, as it was.");
        }
        project.completed = true;
        savePlan(plan);
        fs.rmSync(file, { force: true });
        outcome.state = "done";
        outcome.message = notes.join(" ") || null;
        auditLog("system", "full-restore.project", project.projectName, "ok", { projectId: result.projectId });
      } catch (error) {
        outcome.state = "failed";
        outcome.message = error instanceof Error ? error.message : String(error);
        auditLog("system", "full-restore.project", project.projectName, "fail", { error: outcome.message });
      }
    }
    try { await restoreDeps.publish(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const outcome of current.outcomes) {
        if (outcome.state === "done") { outcome.state = "failed"; outcome.message = `Data restored, but routing failed: ${message}. Retry restoring the projects.`; }
      }
      logger.warn({ error: message }, "full-restore.nginx-failed");
    }
    for (const { projectId, domain } of plan.mode === "recover" ? sslToIssue : []) {
      const result = await restoreDeps.issueSsl(projectId, domain).catch((error: unknown) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));
      const owner = current.outcomes.find((o) => o.name === getProjectById(projectId)?.name);
      if (owner) owner.message = `${owner.message ? `${owner.message} ` : ""}${domain}: ${result.ok ? "TLS certificate issued." : "no TLS certificate yet (point its DNS here, then issue it from the project's domain settings)."}`;
    }
    current.running = false;
    current.finished = true;
    // Everything came back: the plan and the leftovers go. A failure keeps them, so the admin can try again with the same passphrase.
    if (current.outcomes.every((o) => o.state === "done")) { fs.rmSync(restoreDir(), { recursive: true, force: true }); }
  })().catch((error: unknown) => { current.running = false; logger.error({ error: error instanceof Error ? error.message : String(error) }, "full-restore.finish-crashed"); });
  return { ...current };
}

/** The credentials and App binding the project had, where this instance has them under the same ids (the instance backup carries both). */
function applyAuth(projectId: number, project: FullProject, db: Database.Database): void {
  const hasCredential = (id: number | null): id is number => id !== null && !!db.prepare("SELECT 1 FROM credentials WHERE id = ?").get(id);
  const credential = hasCredential(project.auth.credentialId) ? project.auth.credentialId : null;
  const github = hasCredential(project.auth.githubCredentialId) ? project.auth.githubCredentialId : null;
  db.prepare("UPDATE projects SET credential_id = ?, github_credential_id = ? WHERE id = ?").run(credential, github, projectId);
  if (project.auth.mode === "app" && project.auth.installationId !== null && project.auth.repositoryId !== null) {
    const installed = db.prepare("SELECT 1 FROM github_app_installations WHERE installation_id = ?").get(project.auth.installationId);
    if (installed) db.prepare("UPDATE projects SET github_auth_mode = 'app', github_installation_id = ?, github_repository_id = ? WHERE id = ?").run(project.auth.installationId, project.auth.repositoryId, projectId);
  }
}
