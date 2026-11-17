import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { ensureInstanceIdentity } from "../backup/instance";
import { abortMove, beginMove, commitMove, getMove, renewMove, type MoveView } from "../moves/moveOut";
import type { PushTicket } from "../moves/ticketPush";
import { abortTransfer, commitTransfer, domainOptions, getTransfer, keepAlive, prepareTransfer, projectHealth, startImport, startImported, type DomainChoice, type TransferView } from "../moves/transferIn";
import { hasGrant } from "./grants";
import { selfSignedFingerprint } from "./selfCert";
import { PeerError, remoteCall } from "./service";
import { getTarget } from "./store";

/**
 * Runs a move from the controller's side: it asks the target for a ticket, tells the source to stop, copy and push, waits, compares what the two sides
 * attest, starts the project on the target, and only then asks the user. It is not in the data path (the source pushes straight to the target) and it is
 * not the safety net: each side undoes itself if this instance disappears (the source's lease, the target's ticket and silence timeout).
 *
 * A side is either this instance ("local") or a paired peer; the same steps run against either through the same interface.
 */

export type EndpointRef = { kind: "local" } | { kind: "peer"; peerId: number };
export type MoveRunState = "preparing" | "transferring" | "importing" | "starting" | "awaiting-confirmation" | "committing" | "done" | "aborting" | "aborted" | "failed" | "interrupted" | "needs-attention";
const TERMINAL: MoveRunState[] = ["done", "aborted", "failed", "interrupted", "needs-attention"];

export interface MoveRequest { source: EndpointRef; target: EndpointRef; projectId: number; /** The project's name on the source, for display. */ projectName: string; /** The name on the target; the project's own by default. */ name?: string; domains?: DomainChoice[]; allowSameInstance?: boolean }
export interface Step { name: string; status: "running" | "ok" | "failed"; detail: string; at: string }
export interface MoveRun { id: string; source: EndpointRef; target: EndpointRef; projectName: string; state: MoveRunState; steps: Step[]; error: string | null; createdAt: string; updatedAt: string; transfer: TransferView | null; sourceMove: MoveView | null }

interface Row { id: string; source_json: string; target_json: string; project_name: string; state: MoveRunState; steps_json: string; error: string | null; created_at: string; updated_at: string }

// ── the two sides, local or remote, behind one interface ─────────────────────

interface Ticket { transferId: string; token: string; archiveKey: string; expiresAt: string }
interface SourceApi {
  begin(projectId: number, ticket: PushTicket, archiveKey: string): Promise<MoveView>;
  get(id: string): Promise<MoveView>;
  renew(id: string): Promise<MoveView>;
  abort(id: string): Promise<MoveView>;
  commit(id: string, digest: string): Promise<MoveView>;
}
interface TargetApi {
  address(): Promise<{ endpoint: string; fingerprint: string | null }>;
  domains(): Promise<{ bases: { name: string; isDefault: boolean }[]; used: string[] }>;
  prepare(name: string, domains: DomainChoice[]): Promise<Ticket>;
  get(id: string): Promise<TransferView>;
  keepAlive(id: string): Promise<TransferView>;
  import(id: string): Promise<TransferView>;
  start(id: string): Promise<TransferView>;
  health(id: string): Promise<{ healthy: boolean; detail: string }>;
  commit(id: string): Promise<TransferView>;
  abort(id: string): Promise<TransferView>;
}

async function peerCall<T>(peerId: number, method: string, path: string, body: unknown | undefined, db: Database.Database, timeoutMs = 30_000): Promise<T> {
  const answer = await remoteCall(peerId, { method, path, body, control: true, timeoutMs }, db);
  if (answer.status >= 200 && answer.status < 300) return answer.body as T;
  const failure = answer.body as { error?: string; code?: string } | null;
  throw new PeerError(answer.status === 404 ? 404 : answer.status >= 500 ? 502 : answer.status, failure?.error ?? `The peer answered ${answer.status}.`, failure?.code ?? "peer-error");
}

function requireGrants(peerId: number, needed: ("projects:transfer" | "projects:destroy")[], db: Database.Database): void {
  const target = getTarget(peerId, db);
  if (!target) throw new PeerError(404, "No such peer.", "not-found");
  for (const grant of needed) {
    if (!hasGrant(target.grants, grant)) throw new PeerError(403, `${target.name} has not granted this instance ${grant}. Ask its administrator to issue a new pairing with it.`, "forbidden");
  }
}

function localSource(db: Database.Database): SourceApi {
  const self = ensureInstanceIdentity(db).id;
  return {
    begin: (projectId, ticket, archiveKey) => beginMove({ controllerInstance: self, projectId, ticket, archiveKey }, db),
    get: async (id) => getMove(id, self, db),
    renew: async (id) => renewMove(id, self, db),
    abort: (id) => abortMove(id, self, db),
    commit: (id, digest) => commitMove(id, self, digest, db),
  };
}

function peerSource(peerId: number, db: Database.Database): SourceApi {
  return {
    begin: (projectId, ticket, archiveKey) => peerCall(peerId, "POST", "/v1/moves", { projectId, ticket, archiveKey }, db),
    get: (id) => peerCall(peerId, "GET", `/v1/moves/${id}`, undefined, db),
    renew: (id) => peerCall(peerId, "POST", `/v1/moves/${id}/renew`, undefined, db),
    abort: (id) => peerCall(peerId, "POST", `/v1/moves/${id}/abort`, undefined, db, 120_000),
    commit: (id, digest) => peerCall(peerId, "POST", `/v1/moves/${id}/commit`, { digest }, db, 10 * 60_000),
  };
}

function localTarget(db: Database.Database): TargetApi {
  const self = ensureInstanceIdentity(db).id;
  return {
    async address() {
      const domain = (db.prepare("SELECT value FROM app_meta WHERE key = 'nginx_app_domain'").get() as { value: string } | undefined)?.value;
      if (!domain) throw new PeerError(409, "This instance has no public address configured (Settings > Domain), so another instance cannot push a project to it.", "no-address");
      return { endpoint: `https://${domain}`, fingerprint: await selfSignedFingerprint() };
    },
    domains: async () => domainOptions(db),
    prepare: async (name, domains) => prepareTransfer({ controllerInstance: self, name, domains }, db),
    get: async (id) => getTransfer(id, self, db),
    keepAlive: async (id) => keepAlive(id, self, db),
    import: async (id) => startImport(id, self, db),
    start: async (id) => startImported(id, self, db),
    health: async (id) => projectHealth(id, self, db),
    commit: async (id) => commitTransfer(id, self, db),
    abort: (id) => abortTransfer(id, self, db),
  };
}

function peerTarget(peerId: number, db: Database.Database): TargetApi {
  return {
    async address() {
      const t = getTarget(peerId, db);
      if (!t) throw new PeerError(404, "No such peer.", "not-found");
      return { endpoint: t.endpoint, fingerprint: t.certFingerprint };
    },
    domains: () => peerCall(peerId, "GET", "/v1/domains", undefined, db),
    prepare: (name, domains) => peerCall(peerId, "POST", "/v1/transfers", { name, domains }, db),
    get: (id) => peerCall(peerId, "GET", `/v1/transfers/${id}`, undefined, db),
    keepAlive: (id) => peerCall(peerId, "POST", `/v1/transfers/${id}/keepalive`, undefined, db),
    import: (id) => peerCall(peerId, "POST", `/v1/transfers/${id}/import`, undefined, db),
    start: (id) => peerCall(peerId, "POST", `/v1/transfers/${id}/start`, undefined, db),
    health: (id) => peerCall(peerId, "GET", `/v1/transfers/${id}/health`, undefined, db),
    commit: (id) => peerCall(peerId, "POST", `/v1/transfers/${id}/commit`, undefined, db),
    abort: (id) => peerCall(peerId, "POST", `/v1/transfers/${id}/abort`, undefined, db, 120_000),
  };
}

const sourceOf = (ref: EndpointRef, db: Database.Database): SourceApi => (ref.kind === "local" ? localSource(db) : peerSource(ref.peerId, db));
const targetOf = (ref: EndpointRef, db: Database.Database): TargetApi => (ref.kind === "local" ? localTarget(db) : peerTarget(ref.peerId, db));

/** The base domains a target manages and the hostnames it already uses: what the "new hostname" step offers. */
export function targetDomains(ref: EndpointRef, db: Database.Database = getDatabase()): Promise<{ bases: { name: string; isDefault: boolean }[]; used: string[] }> {
  if (ref.kind === "peer") requireGrants(ref.peerId, ["projects:transfer"], db);
  return targetOf(ref, db).domains();
}

// ── tuning (a test shortens these) ───────────────────────────────────────────

export const timing = { pollMs: 2000, renewMs: 15_000, stepTimeoutMs: 6 * 60 * 60_000, healthTimeoutMs: 3 * 60_000, confirmTimeoutMs: 2 * 60 * 60_000 };

/** A reason to stop that is not a transient hiccup: a side said it failed. */
class MoveFailed extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── persistence ──────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString();

function read(id: string, db: Database.Database): Row {
  const r = db.prepare("SELECT * FROM peer_moves WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new PeerError(404, "No such move.", "not-found");
  return r;
}

interface Live { transferId?: string; sourceMoveId?: string; decision: "confirm" | "abort" | null; finished: Promise<void>; settle: () => void }
const live = new Map<string, Live>();

function toRun(r: Row, extra: { transfer: TransferView | null; sourceMove: MoveView | null }): MoveRun {
  return { id: r.id, source: JSON.parse(r.source_json) as EndpointRef, target: JSON.parse(r.target_json) as EndpointRef, projectName: r.project_name, state: r.state, steps: JSON.parse(r.steps_json) as Step[], error: r.error, createdAt: r.created_at, updatedAt: r.updated_at, ...extra };
}

export function listMoves(db: Database.Database = getDatabase()): MoveRun[] {
  return (db.prepare("SELECT * FROM peer_moves ORDER BY created_at DESC LIMIT 30").all() as Row[]).map((r) => toRun(r, { transfer: null, sourceMove: null }));
}

/** The record, with what each side last said (a side that cannot be reached is simply not shown). */
export async function getMoveRun(id: string, db: Database.Database = getDatabase()): Promise<MoveRun> {
  const r = read(id, db);
  const liveState = live.get(id);
  const target = targetOf(JSON.parse(r.target_json) as EndpointRef, db);
  const source = sourceOf(JSON.parse(r.source_json) as EndpointRef, db);
  const [transfer, sourceMove] = await Promise.all([
    liveState?.transferId && !TERMINAL.includes(r.state) ? target.get(liveState.transferId).catch(() => null) : Promise.resolve(null),
    liveState?.sourceMoveId && !TERMINAL.includes(r.state) ? source.get(liveState.sourceMoveId).catch(() => null) : Promise.resolve(null),
  ]);
  return toRun(r, { transfer, sourceMove });
}

function save(id: string, db: Database.Database, patch: { state?: MoveRunState; error?: string | null; steps?: Step[] }): void {
  const r = read(id, db);
  db.prepare("UPDATE peer_moves SET state = ?, error = ?, steps_json = ?, updated_at = ? WHERE id = ?")
    .run(patch.state ?? r.state, patch.error === undefined ? r.error : patch.error, JSON.stringify(patch.steps ?? JSON.parse(r.steps_json)), now(), id);
}

function stepper(id: string, db: Database.Database): (name: string, status: Step["status"], detail?: string) => void {
  return (name, status, detail = "") => {
    const steps = JSON.parse(read(id, db).steps_json) as Step[];
    const last = steps[steps.length - 1];
    if (last && last.name === name && last.status === "running") { last.status = status; last.detail = detail || last.detail; last.at = now(); } else steps.push({ name, status, detail, at: now() });
    save(id, db, { steps });
  };
}

// ── starting a move ──────────────────────────────────────────────────────────

function sameInstance(a: EndpointRef, b: EndpointRef): boolean {
  return a.kind === b.kind && (a.kind === "local" || (b.kind === "peer" && a.peerId === b.peerId));
}

export function startMove(request: MoveRequest, db: Database.Database = getDatabase()): MoveRun {
  const name = (request.name ?? request.projectName).trim();
  if (!name || !Number.isInteger(request.projectId) || request.projectId < 1) throw new PeerError(400, "A project and a name are required.", "bad-request");
  if (sameInstance(request.source, request.target) && !request.allowSameInstance) throw new PeerError(400, "The source and the target are the same instance.", "bad-request");
  if (request.source.kind === "peer") requireGrants(request.source.peerId, ["projects:transfer", "projects:destroy"], db);
  if (request.target.kind === "peer") requireGrants(request.target.peerId, ["projects:transfer"], db);
  const active = (db.prepare("SELECT COUNT(*) AS n FROM peer_moves WHERE state NOT IN ('done','aborted','failed','interrupted','needs-attention')").get() as { n: number }).n;
  if (active >= 3) throw new PeerError(429, "Too many moves are in progress.", "busy");

  const id = randomUUID();
  db.prepare("INSERT INTO peer_moves (id, source_json, target_json, project_name, state, steps_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, JSON.stringify(request.source), JSON.stringify(request.target), request.projectName, "preparing", "[]", now(), now());
  let settle!: () => void;
  const finished = new Promise<void>((resolve) => { settle = resolve; });
  live.set(id, { decision: null, finished, settle });
  void run(id, { ...request, name }, db).catch((error: unknown) => logger.error({ moveRun: id, error: String(error) }, "move.orchestration-crashed")).finally(() => { live.get(id)?.settle(); live.delete(id); });
  auditLog("admin", "move.requested", request.projectName, "ok", { moveRun: id });
  return toRun(read(id, db), { transfer: null, sourceMove: null });
}

/** Waits for `done()` to be true, keeping the source's lease alive, and stopping at once if the user asks to abort. */
async function waitFor(id: string, source: SourceApi, state: () => { sourceMoveId?: string }, done: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  let renewed = 0;
  let failures = 0;
  for (;;) {
    if (live.get(id)?.decision === "abort") throw new Error("Aborted.");
    try {
      if (await done()) return;
      failures = 0;
    } catch (error) {
      // A call that timed out or was refused once says nothing about the move; several in a row do.
      if (error instanceof MoveFailed || ++failures >= 5) throw error;
      logger.warn({ moveRun: id, error: String(error) }, "move.poll-failed");
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    const moveId = state().sourceMoveId;
    if (moveId && Date.now() - renewed >= timing.renewMs) { renewed = Date.now(); await source.renew(moveId).catch((error: unknown) => logger.warn({ moveRun: id, error: String(error) }, "move.renew-failed")); }
    await sleep(timing.pollMs);
  }
}

async function run(id: string, request: MoveRequest & { name: string }, db: Database.Database): Promise<void> {
  const step = stepper(id, db);
  const source = sourceOf(request.source, db);
  const target = targetOf(request.target, db);
  const ctx = live.get(id) as Live;
  try {
    step("Prepare the target", "running");
    const ticket = await target.prepare(request.name, request.domains ?? []);
    ctx.transferId = ticket.transferId;
    const address = await target.address();
    step("Prepare the target", "ok", "The target is ready to receive the project.");

    save(id, db, { state: "transferring" });
    step("Stop the project and copy it", "running");
    const begun = await source.begin(request.projectId, { endpoint: address.endpoint, fingerprint: address.fingerprint, transferId: ticket.transferId, token: ticket.token }, ticket.archiveKey);
    ctx.sourceMoveId = begun.id;
    let sourceView: MoveView = begun;
    await waitFor(id, source, () => ctx, async () => {
      sourceView = await source.get(begun.id);
      if (sourceView.state === "rolled-back" || sourceView.state === "needs-attention") throw new MoveFailed(sourceView.error ?? "The source could not copy the project and took it back.");
      return sourceView.state === "awaiting-confirmation";
    }, timing.stepTimeoutMs, "the source to finish copying");
    step("Stop the project and copy it", "ok", "The project is stopped on the source and its archive reached the target.");

    save(id, db, { state: "importing" });
    step("Import and verify on the target", "running");
    await target.import(ticket.transferId);
    let transfer!: TransferView;
    await waitFor(id, source, () => ctx, async () => {
      transfer = await target.get(ticket.transferId);
      if (transfer.state === "failed") throw new MoveFailed(transfer.error ?? "The target could not import the project.");
      return transfer.state === "imported";
    }, timing.stepTimeoutMs, "the target to import");
    // What each side attests, over its own signed channel: the source's digest recorded at export, the target's recomputed from what it wrote.
    if (!sourceView.digest || transfer.digest !== sourceView.digest) throw new MoveFailed("The target's copy does not match what the source archived (digests differ). Nothing was destroyed.");
    step("Import and verify on the target", "ok", `Verified: the target's data matches the source's (${transfer.digest.slice(0, 12)}…).`);

    save(id, db, { state: "starting" });
    step("Start the project on the target", "running");
    await target.start(ticket.transferId);
    await waitFor(id, source, () => ctx, async () => {
      const t = await target.get(ticket.transferId);
      if (t.state === "failed") throw new MoveFailed(t.error ?? "The project did not start on the target.");
      return t.state === "started";
    }, timing.stepTimeoutMs, "the project to start");
    await waitFor(id, source, () => ctx, async () => (await target.health(ticket.transferId)).healthy, timing.healthTimeoutMs, "the project to pass its health check");
    step("Start the project on the target", "ok", "The project is running on the target and passes its health check.");

    save(id, db, { state: "awaiting-confirmation" });
    step("Your confirmation", "running", "The source is stopped, the copy is verified and running. Confirm to remove the source, or abort to go back.");
    // Both sides are watched while the user decides: if the source took the project back on its own (its lease lapsed), the copy must not be confirmed.
    const stillHeld = async (): Promise<void> => {
      const held = await source.get(begun.id);
      if (held.state !== "awaiting-confirmation") throw new MoveFailed(`The source took the project back (${held.state}${held.error ? `: ${held.error}` : ""}), so the copy cannot be confirmed.`);
    };
    await waitFor(id, source, () => ctx, async () => {
      await target.keepAlive(ticket.transferId); // tells the target someone is still here
      await stillHeld();
      return live.get(id)?.decision === "confirm";
    }, timing.confirmTimeoutMs, "your confirmation");
    await stillHeld();

    save(id, db, { state: "committing" });
    step("Your confirmation", "ok", "Confirmed.");
    step("Remove the source", "running");
    try {
      await target.commit(ticket.transferId);
    } catch (error) {
      // An answer that never came is not a refusal: the target may have committed. Look before undoing anything, or the source would be restarted beside a committed copy.
      const after = await target.get(ticket.transferId).catch(() => null);
      if (after?.state !== "committed") {
        if (after) throw error; // the target is reachable and did not commit: the usual way back
        const message = error instanceof Error ? error.message : String(error);
        step("Remove the source", "failed", message);
        save(id, db, { state: "needs-attention", error: `The target did not answer the confirmation (${message}). It may hold the committed project and the source is still stopped: check the target, then abort or confirm from its state. Nothing was removed.` });
        return;
      }
    }
    try {
      await source.commit(begun.id, sourceView.digest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code ?? "";
      step("Remove the source", "failed", message);
      // Refused before anything was removed (digest, lease, state): the source is intact and both instances hold the project. Anything else: the source may be partly removed.
      const untouched = ["digest-mismatch", "lease-lapsed", "wrong-state", "forbidden"].includes(code);
      save(id, db, { state: "needs-attention", error: untouched
        ? `The project runs on the target, and the source was NOT removed (${message}). Both instances hold a copy: delete the one you do not want.`
        : `The project now runs on the target, but the source could not be removed completely: ${message}` });
      return;
    }
    step("Remove the source", "ok", "The project was removed from the source.");
    save(id, db, { state: "done" });
    auditLog("admin", "move.done", request.projectName, "ok", { moveRun: id });
  } catch (error) {
    const aborted = live.get(id)?.decision === "abort";
    const message = error instanceof Error ? error.message : String(error);
    save(id, db, { state: "aborting" });
    const trouble = await undo(ctx, source, target);
    const last = (JSON.parse(read(id, db).steps_json) as Step[]).slice(-1)[0];
    if (last?.status === "running") step(last.name, "failed", aborted ? "Aborted." : message);
    if (trouble.length) {
      save(id, db, { state: "needs-attention", error: `${aborted ? "Aborted" : message} Undoing it was incomplete: ${trouble.join(" ")}` });
    } else {
      step("Go back", "ok", "The source project is back as it was, and the target's copy is removed.");
      save(id, db, { state: aborted ? "aborted" : "failed", error: aborted ? null : message });
    }
  }
}

/** Returns every side to how it was. A failure here is reported, not hidden. */
async function undo(ctx: Live, source: SourceApi, target: TargetApi): Promise<string[]> {
  const trouble: string[] = [];
  if (ctx.sourceMoveId) {
    try {
      const view = await source.abort(ctx.sourceMoveId);
      if (view.state === "needs-attention") trouble.push(`The source could not be restored: ${view.error ?? "see its page"}.`);
    } catch (error) { if (!/committed/.test(String(error))) trouble.push(`The source could not be reached to give the project back (${String(error instanceof Error ? error.message : error)}); it restores itself when its lease lapses.`); }
  }
  if (ctx.transferId) {
    try { await target.abort(ctx.transferId); } catch (error) { trouble.push(`The target's copy could not be removed (${String(error instanceof Error ? error.message : error)}); it removes itself when its ticket goes quiet.`); }
  }
  return trouble;
}

/** The user's answer. A confirmation counts only while the move is waiting for it. */
export async function decide(id: string, decision: "confirm" | "abort", db: Database.Database = getDatabase()): Promise<MoveRun> {
  const r = read(id, db);
  const liveState = live.get(id);
  if (!liveState) {
    if (decision === "abort" && !TERMINAL.includes(r.state)) throw new PeerError(409, "This move is no longer running here.", "wrong-state");
    throw new PeerError(409, `This move is ${r.state}.`, "wrong-state");
  }
  if (decision === "confirm" && r.state !== "awaiting-confirmation") throw new PeerError(409, "There is nothing to confirm yet: the copy has not been verified and started.", "wrong-state");
  // Once the user has chosen, a later click or a stale tab cannot change it: an abort in flight is never turned into a confirmation.
  if (liveState.decision && liveState.decision !== decision) throw new PeerError(409, `This move was already told to ${liveState.decision}.`, "wrong-state");
  liveState.decision = decision;
  if (decision === "abort") await liveState.finished;
  return getMoveRun(id, db);
}

/** Finished moves are kept a month for the record. */
export function pruneRuns(db: Database.Database = getDatabase()): void {
  db.prepare("DELETE FROM peer_moves WHERE state IN ('done','aborted','failed','interrupted') AND updated_at < ?").run(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
}

/** After a restart: a move this process was running cannot continue, and each side takes itself back; say so. */
export function reconcileRuns(db: Database.Database = getDatabase()): void {
  const stale = db.prepare("SELECT id FROM peer_moves WHERE state NOT IN ('done','aborted','failed','interrupted','needs-attention')").all() as { id: string }[];
  for (const { id } of stale) {
    if (live.has(id)) continue;
    save(id, db, { state: "interrupted", error: "This instance restarted in the middle of the move. The source takes the project back when its lease lapses, and the target removes its copy when it goes quiet; check both if either still shows the project." });
  }
}
