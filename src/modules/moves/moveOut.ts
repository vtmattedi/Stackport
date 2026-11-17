/* eslint-disable security/detect-object-injection -- the keys are fixed column names in this module. */
/* eslint-disable security/detect-non-literal-fs-filename -- paths are Stackport's own transfer directory and a move id it generated. */
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { actionRegistry, projectRepoKey } from "../actions/registry";
import { exportProject, projectDirs } from "../backup/projectArchive";
import { DockerVolumeEngine, type VolumeEngine, type VolumeSource } from "../backup/volumeEngine";
import { currentVolumeRoots, managedVolumesRoot } from "../deployments/compose/managedVolumes";
import { healthChecker } from "../deployments/health";
import { composeProject, getProjectById, stopAndPurgeProject, stopProject } from "../deployments/operations";
import { destroyProject } from "../projects/destroy";
import { deployRoot as configuredDeployRoot, expectedComposeProjectName } from "../projects/workspace";
import { PushError, pushArchive, type PushTicket } from "./ticketPush";

/**
 * The source of a move. Version 1 is stop, copy, start: this instance stops the project, archives it, pushes the archive to the target's ticket, and waits.
 * Nothing is destroyed until the controller commits with the digest this instance recorded. Until then every way out leads back to exactly the state recorded
 * before anything was touched:
 *
 *   - the move holds the project's action slot, so nothing else can deploy, restart or delete it (a webhook deploy finds it busy, the delete route refuses);
 *   - a lease: the controller renews it; if it lapses (a crashed controller, a lost network) the project is restored by this instance, on its own;
 *   - a restart of this instance finds the move unfinished and restores;
 *   - a restore that fails is "needs-attention": recorded, audited and logged loudly, never silent.
 */

export const LEASE_MS = 90_000;

export type MoveState = "preparing" | "stopping" | "exporting" | "transferring" | "awaiting-confirmation" | "committing" | "committed" | "rolling-back" | "rolled-back" | "needs-attention";
const ACTIVE: MoveState[] = ["preparing", "stopping", "exporting", "transferring", "awaiting-confirmation", "committing", "rolling-back"];

export class MoveError extends Error {
  constructor(readonly status: number, message: string, readonly code = "move-error", readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Original { wasRunning: boolean; paused: boolean }
interface Row {
  id: string; project_id: number; project_name: string; controller_instance: string; state: MoveState; original_json: string; digest: string | null;
  sent_bytes: number; lease_expires_at: string; error: string | null; created_at: string; updated_at: string;
}

export interface MoveView { id: string; projectId: number; projectName: string; state: MoveState; digest: string | null; sentBytes: number; leaseExpiresAt: string; error: string | null }

/** What this module calls out to, so a test can stand in for Docker. */
export interface MoveDeps {
  engine: () => Promise<VolumeEngine | null>;
  stop: (projectId: number) => Promise<{ ok: boolean; output: string }>;
  start: (projectId: number) => Promise<{ ok: boolean; output: string }>;
  purge: (projectId: number) => Promise<void>;
  leaseMs: number;
  pollMs: number;
}
export const deps: MoveDeps = {
  engine: () => DockerVolumeEngine.create(),
  stop: (id) => stopProject(id),
  start: (id) => composeProject(id),
  purge: async (id) => { await stopAndPurgeProject(id); },
  leaseMs: LEASE_MS,
  pollMs: 1000,
};

const now = (): string => new Date().toISOString();
const ID_RE = /^[0-9a-f-]{36}$/;
const stagingDir = (id: string): string => path.join(currentVolumeRoots().containerDataRoot, "transfers", `out-${id}`);

function row(id: string, db: Database.Database): Row {
  const found = ID_RE.test(id) ? (db.prepare("SELECT * FROM project_moves_out WHERE id = ?").get(id) as Row | undefined) : undefined;
  if (!found) throw new MoveError(404, "No such move.", "not-found");
  return found;
}

const view = (r: Row): MoveView => ({ id: r.id, projectId: r.project_id, projectName: r.project_name, state: r.state, digest: r.digest, sentBytes: r.sent_bytes, leaseExpiresAt: r.lease_expires_at, error: r.error });

function setState(id: string, state: MoveState, db: Database.Database, fields: Record<string, string | number | null> = {}): void {
  const columns = Object.keys(fields);
  db.prepare(`UPDATE project_moves_out SET state = ?, updated_at = ?${columns.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`).run(state, now(), ...columns.map((c) => fields[c]), id);
}

const leaseLapsed = (r: Row): boolean => Date.parse(r.lease_expires_at) < Date.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Driver { stop: boolean; decision: "commit" | "abort" | null; finished: Promise<void>; settle: () => void }
const drivers = new Map<string, Driver>();

function owned(r: Row, controllerInstance: string): void {
  if (r.controller_instance !== controllerInstance) throw new MoveError(404, "No such move.", "not-found");
}

export function getMove(id: string, controllerInstance: string, db: Database.Database = getDatabase()): MoveView {
  const r = row(id, db);
  owned(r, controllerInstance);
  return view(r);
}

/** The controller is alive and still wants this move: the lease runs on. */
export function renewMove(id: string, controllerInstance: string, db: Database.Database = getDatabase(), holdMs?: number): MoveView {
  const r = row(id, db);
  owned(r, controllerInstance);
  // Around the commit the controller asks for longer (never more than 20 minutes): a controller that restarts there must be able to finish what it began before the source takes the project back.
  const span = holdMs !== undefined && r.state === "awaiting-confirmation" ? Math.min(Math.max(holdMs, deps.leaseMs), 20 * 60_000) : deps.leaseMs;
  if (ACTIVE.includes(r.state)) db.prepare("UPDATE project_moves_out SET lease_expires_at = ?, updated_at = ? WHERE id = ?").run(new Date(Date.now() + span).toISOString(), now(), id);
  return view(row(id, db));
}

export interface BeginInput { controllerInstance: string; projectId: number; ticket: PushTicket; archiveKey: string }

function checkTicket(ticket: PushTicket): void {
  if (!ticket || typeof ticket.endpoint !== "string" || !ID_RE.test(String(ticket.transferId)) || !/^[A-Za-z0-9_-]{20,128}$/.test(String(ticket.token)) || (ticket.fingerprint !== null && typeof ticket.fingerprint !== "string")) {
    throw new MoveError(400, "The ticket is not valid.", "bad-request");
  }
}

/** Takes the project, and returns at once: the stop, the copy and the push run in the background, and `getMove` says how far they got. */
export async function beginMove(input: BeginInput, db: Database.Database = getDatabase()): Promise<MoveView> {
  checkTicket(input.ticket);
  if (typeof input.archiveKey !== "string" || input.archiveKey.length < 20) throw new MoveError(400, "The archive key is not valid.", "bad-request");
  const project = getProjectById(input.projectId);
  if (!project) throw new MoveError(404, "Project not found.", "not-found");
  const engine = await deps.engine();
  if (!engine) throw new MoveError(503, "Moving a project needs Docker (the privileged helper reads its data); Docker is not reachable from here.", "needs-helper");
  if (db.prepare(`SELECT 1 FROM project_moves_out WHERE project_id = ? AND state IN (${ACTIVE.map(() => "?").join(",")}) OR (project_id = ? AND state = 'needs-attention')`).get(project.id, ...ACTIVE, project.id)) {
    throw new MoveError(409, "This project already has a move in progress, or one that needs attention.", "move-exists");
  }
  const original: Original = { wasRunning: (await engine.runningContainers(expectedComposeProjectName(project))).length > 0, paused: project.paused };
  const id = randomUUID();
  let driver!: Driver;
  const finished = new Promise<void>((resolve) => { driver = { stop: false, decision: null, finished: undefined as unknown as Promise<void>, settle: resolve }; });
  driver.finished = finished;
  db.prepare(`INSERT INTO project_moves_out (id, project_id, project_name, controller_instance, state, original_json, lease_expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, project.id, project.name, input.controllerInstance, "preparing", JSON.stringify(original), new Date(Date.now() + deps.leaseMs).toISOString(), now(), now());
  // The lock: the project's action slot, held until the move ends. Anything else that wants it is told it is busy.
  const slot = actionRegistry.tryStart(projectRepoKey(project.id), "move", { projectId: project.id, moveId: id, triggeredBy: "move" }, async () => {
    try { await drive(id, input, engine, db, driver); } finally { driver.settle(); }
    const end = row(id, db);
    return { ok: end.state === "committed" || end.state === "rolled-back", output: end.error ?? end.state };
  });
  if (!slot) {
    db.prepare("DELETE FROM project_moves_out WHERE id = ?").run(id);
    throw new MoveError(409, "Another action is running on this project. Wait for it to finish.", "busy");
  }
  drivers.set(id, driver);
  auditLog(`peer:${input.controllerInstance}`, "move.started", project.name, "ok", { moveId: id, projectId: project.id });
  return view(row(id, db));
}

class Lapsed extends Error {}
class Stopped extends Error {}

function check(id: string, db: Database.Database, driver: Driver): void {
  if (driver.stop) throw new Stopped("The move was aborted.");
  if (leaseLapsed(row(id, db))) throw new Lapsed("The controller stopped renewing the move, so this instance is taking the project back.");
}

async function drive(id: string, input: BeginInput, engine: VolumeEngine, db: Database.Database, driver: Driver): Promise<void> {
  const project = getProjectById(input.projectId)!;
  try {
    // Quiesce: nothing deploys it by itself while it moves (auto-deploy and health checks look at `paused`).
    setState(id, "stopping", db);
    db.prepare("UPDATE projects SET paused = 1, updated_at = ? WHERE id = ?").run(now(), project.id);
    healthChecker.unschedule(project.id);
    const stopped = await deps.stop(project.id);
    if (!stopped.ok) throw new Error(`The project could not be stopped: ${stopped.output.slice(-300)}`);
    if ((await engine.runningContainers(expectedComposeProjectName(project))).length) throw new Error("The project still has running containers after it was stopped.");
    check(id, db, driver);

    setState(id, "exporting", db);
    const dir = stagingDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "archive.spbackup");
    const manifest = await exportProject({ projectId: project.id, outPath: file, passphrase: input.archiveKey, engine });
    setState(id, "transferring", db, { digest: manifest.digest });
    check(id, db, driver);

    await pushArchive(file, input.ticket, {
      onProgress: (sent) => { db.prepare("UPDATE project_moves_out SET sent_bytes = ?, updated_at = ? WHERE id = ?").run(sent, now(), id); },
      shouldStop: () => driver.stop || leaseLapsed(row(id, db)),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    setState(id, "awaiting-confirmation", db);

    // The project stays down and this instance waits: for the commit, the abort, or the lease to lapse.
    while (!driver.decision) {
      const current = row(id, db);
      // Once the commit has begun it is not interrupted by the lease: only the commit itself ends it.
      if (current.state !== "committing" && leaseLapsed(current)) throw new Lapsed("The controller stopped renewing the move, so this instance is taking the project back.");
      await sleep(deps.pollMs);
    }
    if (driver.decision === "abort") throw new Stopped("The move was aborted.");
    // "commit": commitMove has done the work and set the state; nothing left here.
  } catch (error) {
    const reason = error instanceof PushError && error.code === "stopped" ? (driver.stop ? "The move was aborted." : "The controller stopped renewing the move.") : error instanceof Error ? error.message : String(error);
    await rollback(id, reason, db, engine, error instanceof Stopped || driver.stop);
  } finally {
    fs.rmSync(stagingDir(id), { recursive: true, force: true });
    drivers.delete(id);
  }
}

/** Back to what was recorded before anything was touched. Safe to repeat; a failure is recorded as needing attention. */
async function rollback(id: string, reason: string, db: Database.Database, engine: VolumeEngine | null, requested: boolean): Promise<void> {
  const r = row(id, db);
  if (r.state === "committed" || r.state === "committing") return;
  setState(id, "rolling-back", db, { error: requested ? null : reason });
  try {
    const original = JSON.parse(r.original_json) as Original;
    const project = getProjectById(r.project_id);
    if (!project) throw new Error("The project no longer exists.");
    if (original.wasRunning) {
      const started = await deps.start(project.id);
      if (!started.ok) throw new Error(`The project could not be started again: ${started.output.slice(-300)}`);
      const live = engine ? await engine.runningContainers(expectedComposeProjectName(project)) : ["unchecked"];
      if (!live.length) throw new Error("The project was started again but has no running containers.");
    }
    db.prepare("UPDATE projects SET paused = ?, updated_at = ? WHERE id = ?").run(original.paused ? 1 : 0, now(), project.id);
    const restored = getProjectById(project.id);
    if (restored) healthChecker.schedule(restored);
    setState(id, "rolled-back", db);
    auditLog(`peer:${r.controller_instance}`, "move.rolled-back", r.project_name, "ok", { moveId: id, reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(id, "needs-attention", db, { error: `The project could not be restored to how it was: ${message}` });
    logger.error({ moveId: id, projectId: r.project_id, error: message }, "move.needs-attention");
    auditLog(`peer:${r.controller_instance}`, "move.needs-attention", r.project_name, "fail", { moveId: id, error: message });
  }
}

/** Gives the project back: whatever stage the move is in. */
export async function abortMove(id: string, controllerInstance: string, db: Database.Database = getDatabase()): Promise<MoveView> {
  const r = row(id, db);
  owned(r, controllerInstance);
  if (r.state === "committed") throw new MoveError(409, "This move was committed: the source project is gone.", "wrong-state", { state: r.state });
  // From the commit on there is no way back: the target has the project, and the source may already be partly removed.
  if (r.state === "committing" || (r.state === "needs-attention" && /^The move was confirmed/.test(r.error ?? ""))) {
    throw new MoveError(409, "The move was confirmed, so it cannot be undone. The project runs on the target; remove what is left on this instance by hand.", "wrong-state", { state: r.state });
  }
  const driver = drivers.get(id);
  if (driver) {
    driver.stop = true;
    driver.decision = "abort";
    await driver.finished;
  } else if (ACTIVE.includes(r.state) || r.state === "needs-attention") {
    // No driver here (this instance restarted): do the rollback directly, holding the slot like any action.
    await runRollbackAction(r, "The move was aborted.", db, true);
  }
  return view(row(id, db));
}

async function runRollbackAction(r: Row, reason: string, db: Database.Database, requested: boolean): Promise<void> {
  const engine = await deps.engine();
  await new Promise<void>((resolve) => {
    const slot = actionRegistry.tryStart(projectRepoKey(r.project_id), "move", { projectId: r.project_id, moveId: r.id, triggeredBy: "move" }, async () => {
      try { await rollback(r.id, reason, db, engine, requested); } finally { resolve(); }
      return { ok: row(r.id, db).state === "rolled-back", output: reason };
    });
    if (!slot) resolve();
  });
}

/** The point of no return: destroys the source project, its data and its volumes. Only with the digest this instance recorded, so a copy that was cut short
 *  (or another move's digest) cannot trigger it. */
export async function commitMove(id: string, controllerInstance: string, digest: string, db: Database.Database = getDatabase()): Promise<MoveView> {
  const r = row(id, db);
  owned(r, controllerInstance);
  if (r.state === "committed") return view(r);
  if (r.state !== "awaiting-confirmation") throw new MoveError(409, `This move is ${r.state}: only a move that has been transferred can be committed.`, "wrong-state", { state: r.state });
  if (!r.digest || digest !== r.digest) {
    auditLog(`peer:${controllerInstance}`, "move.commit-refused", r.project_name, "fail", { moveId: id });
    throw new MoveError(409, "The digest does not match what this instance recorded when it archived the project. Nothing was destroyed.", "digest-mismatch");
  }
  if (leaseLapsed(r)) throw new MoveError(409, "The move's lease has lapsed: this instance is taking the project back.", "lease-lapsed");
  const driver = drivers.get(id);
  // Before anything is destroyed: without the helper the volumes' data would be left behind with nothing pointing at it.
  const engine = await deps.engine();
  if (!engine) throw new MoveError(503, "Docker cannot be reached from here, so the original's data cannot be removed. Nothing was destroyed; confirm again once Docker answers.", "needs-helper");
  setState(id, "committing", db);
  try {
    const project = getProjectById(r.project_id);
    if (project) {
      await deps.purge(project.id).catch(() => undefined);
      const roots = currentVolumeRoots();
      const volumes: VolumeSource[] = [{ kind: "bind", hostPath: managedVolumesRoot(roots, project.id).host }];
      for (const named of await engine.namedVolumes(expectedComposeProjectName(project))) volumes.push({ kind: "named", name: named.name });
      for (const volume of volumes) await engine.remove(volume);
      const dirs = projectDirs({ id: project.id, name: project.name, source_type: project.sourceType }, roots, path.resolve(configuredDeployRoot()));
      if (dirs.repo) fs.rmSync(dirs.repo, { recursive: true, force: true });
      fs.rmSync(dirs.volumes, { recursive: true, force: true });
      const destroyed = await destroyProject(project.id, db);
      if (!destroyed.ok) throw new Error(destroyed.error);
    }
    setState(id, "committed", db, { error: null });
    auditLog(`peer:${controllerInstance}`, "move.committed", r.project_name, "ok", { moveId: id, projectId: r.project_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(id, "needs-attention", db, { error: `The move was confirmed but the source could not be removed completely: ${message}` });
    logger.error({ moveId: id, error: message }, "move.commit-failed");
    auditLog(`peer:${controllerInstance}`, "move.commit-failed", r.project_name, "fail", { moveId: id, error: message });
    if (driver) { driver.decision = "commit"; await driver.finished; }
    throw new MoveError(502, `The source could not be removed completely: ${message}. The project now runs on the target; remove this one by hand.`, "commit-incomplete");
  }
  if (driver) { driver.decision = "commit"; await driver.finished; }
  return view(row(id, db));
}

/** After a restart, or on a timer: a move whose driver is gone cannot be renewed or finished by anyone, so the project is given back. */
export async function reconcileMoves(db: Database.Database = getDatabase()): Promise<void> {
  const rows = db.prepare(`SELECT * FROM project_moves_out WHERE state IN (${ACTIVE.map(() => "?").join(",")})`).all(...ACTIVE) as Row[];
  for (const r of rows) {
    if (drivers.has(r.id)) continue;
    if (r.state === "committing") {
      // The target already holds the project (it commits first), and how much of the source was removed is not known: nothing to roll back to.
      setState(r.id, "needs-attention", db, { error: "The move was confirmed but this instance restarted while the source was being removed. The project runs on the target; check what is left here and remove it by hand." });
      logger.error({ moveId: r.id, projectId: r.project_id }, "move.needs-attention");
      auditLog(`peer:${r.controller_instance}`, "move.needs-attention", r.project_name, "fail", { moveId: r.id });
      continue;
    }
    await runRollbackAction(r, "This instance restarted in the middle of the move.", db, false);
  }
}

/** Finished moves are kept a week for the record. */
export function pruneMoves(db: Database.Database = getDatabase()): void {
  db.prepare("DELETE FROM project_moves_out WHERE state IN ('committed','rolled-back') AND updated_at < ?").run(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
}
