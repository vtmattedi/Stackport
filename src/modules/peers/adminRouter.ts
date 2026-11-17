import { randomUUID } from "crypto";
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../identity/middleware/session";
import { auditLog } from "../../shared/logger";
import { ensureInstanceIdentity, setInstanceName } from "../backup/instance";
import { parseLogQuery } from "../deployments/logQuery";
import { selfSignedFingerprint } from "./selfCert";
import { GRANTS, GrantError, grantImplications } from "./grants";
import { checkPeer, forgetPeer, peerStatus } from "./monitor";
import { PeerIdentityError, PeerUnreachable } from "./client";
import { forgetRemoteCache, issuePairingCode, peekRemote, PeerError, registerTarget, remoteCall, remoteGet, removeTargetAndNotify, rotateTargetKey, STATUS_PATH } from "./service";
import { statusHub } from "../status/hub";
import { OPERATION_ID_PATTERN } from "./signing";
import { isStatusReport, summarize, type PeerStatusReport, type StatusSummary } from "./peerStatus";
import { MoveError } from "../moves/moveOut";
import { TransferError } from "../moves/transferIn";
import { decide, getMoveRun, listMoves, startMove, targetDomains, type EndpointRef } from "./moveOrchestrator";
import { deleteRevokedController, listControllers, listTargets, revokeController } from "./store";

/** Admin management of peers from this instance's own UI (session auth). Pairing codes and keys are never listed: a code is shown once at creation, a key never. */
const router = Router();

function idParam(req: Request<{ id: string }>, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return null; }
  return id;
}

function handle(res: Response, error: unknown): void {
  if (error instanceof PeerError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof TransferError || error instanceof MoveError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof GrantError) { res.status(400).json({ error: error.message, code: "bad-grants" }); return; }
  if (error instanceof PeerIdentityError) { res.status(502).json({ error: error.message, code: "identity-mismatch" }); return; }
  if (error instanceof PeerUnreachable) { res.status(502).json({ error: error.message, code: "unreachable" }); return; }
  throw error;
}

/** This instance's own numbers, for the fleet view. A collector that is failing leaves it null rather than failing the whole page. */
async function localSummary(): Promise<StatusSummary | null> {
  try { return summarize(await statusHub.current()); } catch { return null; }
}

router.get("/local-summary", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json({ summary: await localSummary() });
});

router.get("/", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json({
    self: ensureInstanceIdentity(),
    selfSignedFingerprint: await selfSignedFingerprint(),
    grantsAvailable: GRANTS,
    grantImplications: grantImplications(),
    controlling: listTargets().map((target) => {
      // What the monitor last read from the peer (memory only); an offline peer keeps its last numbers, and `summaryAt` says how old they are.
      const last = peekRemote<PeerStatusReport>(target.id, STATUS_PATH);
      const report = last && isStatusReport(last.data) ? last.data : null;
      return { ...target, status: peerStatus(target.id) ?? { state: "unknown" }, summary: report ? summarize(report) : null, summaryAt: report ? last?.fetchedAt ?? null : null };
    }),
    controlledBy: listControllers(),
  });
});

router.put("/self", requireAuth, (req: Request, res: Response): void => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 80) throw new PeerError(400, "An instance name is 1 to 80 characters.", "bad-name");
    const self = setInstanceName(name);
    auditLog(req.user ?? "unknown", "instance.rename", self.id, "ok", { name: self.name });
    res.json(self);
  } catch (error) { handle(res, error); }
});

/** On the instance that will be controlled: issues a single-use code naming what the controller may do. */
router.post("/pairing-codes", requireAuth, (req: Request, res: Response): void => {
  try {
    const issued = issuePairingCode({ endpoint: String(req.body?.endpoint ?? ""), fingerprint: typeof req.body?.fingerprint === "string" ? req.body.fingerprint : null, grants: req.body?.grants, ttlMinutes: typeof req.body?.ttlMinutes === "number" ? req.body.ttlMinutes : undefined });
    auditLog(req.user ?? "unknown", "peer.pairing-code.issue", "peer", "ok", { grants: issued.grants, expiresAt: issued.expiresAt });
    res.status(201).json(issued);
  } catch (error) { handle(res, error); }
});

/** On the controlling instance: registers a peer from its code. */
router.post("/targets", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const target = await registerTarget(String(req.body?.code ?? ""));
    auditLog(req.user ?? "unknown", "peer.register", target.instanceId, "ok", { name: target.name, grants: target.grants });
    res.status(201).json(target);
  } catch (error) { handle(res, error); }
});

router.post("/targets/:id/refresh", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  if (id === null) return;
  try { res.json(await checkPeer(id)); } catch (error) { handle(res, error); }
});

router.post("/targets/:id/rotate-key", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  if (id === null) return;
  try {
    await rotateTargetKey(id);
    auditLog(req.user ?? "unknown", "peer.key-rotate", String(id), "ok");
    res.status(204).end();
  } catch (error) { handle(res, error); }
});

router.delete("/targets/:id", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  if (id === null) return;
  try {
    const { notified } = await removeTargetAndNotify(id);
    forgetPeer(id);
    forgetRemoteCache(id);
    auditLog(req.user ?? "unknown", "peer.remove", String(id), "ok", { notified });
    res.json({ notified });
  } catch (error) { handle(res, error); }
});

router.get("/targets/:id/status", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  if (id === null) return;
  try { res.json(await remoteGet(id, STATUS_PATH, { validate: isStatusReport })); } catch (error) { handle(res, error); }
});

// ── a peer's project API (read and write) ────────────────────────────────────
// The management UI's one door to another instance's projects. The path is the application's own (/projects/5/deploy, /domains, ...); the peer
// decides what exists for this instance and what it may do, and answers with its own status and body. A write carries an operation id, so a retry after a lost
// answer returns the first result instead of acting twice.

const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PROXY_PATH = /^\/[A-Za-z0-9/_.,:=&%?-]{0,1999}$/;

router.use("/targets/:id/api", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  if (id === null) return;
  if (!PROXY_METHODS.has(req.method)) { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!PROXY_PATH.test(req.url) || req.url.includes("..")) { res.status(400).json({ error: "Invalid path" }); return; }
  const mutating = req.method !== "GET";
  const supplied = req.get("x-operation-id");
  const operationId = mutating ? (supplied && OPERATION_ID_PATTERN.test(supplied) ? supplied : randomUUID()) : undefined;
  const body = mutating && req.body && typeof req.body === "object" && Object.keys(req.body as object).length > 0 ? req.body : mutating ? {} : undefined;
  try {
    const result = await remoteCall(id, { method: req.method, path: req.url, body, operationId });
    if (operationId) res.setHeader("X-Operation-Id", operationId);
    if (result.replayed) res.setHeader("X-SP-Replayed", "true");
    // By what the peer said it sent: a stored action log is text even when it happens to parse as JSON.
    if (result.contentType?.includes("json") && result.body !== null && result.body !== undefined) res.status(result.status).json(result.body);
    // Whatever the peer calls it, it is shown as plain text from this origin: a peer cannot serve a page (and its scripts) from the management UI.
    else if (result.text) res.status(result.status).type("text/plain").set("X-Content-Type-Options", "nosniff").send(result.text);
    else res.status(result.status).end();
  } catch (error) { handle(res, error); }
});

// ── a peer's projects (read only) ─────────────────────────────────────────────
// Each call is made by this instance to the peer's own control API, signed, and answered from the peer's own services: this instance
// keeps no copy beyond the last answer in memory, which an unreachable peer falls back to (marked stale).

function projectParam(req: Request<{ id: string; projectId: string }>, res: Response): number | null {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid project id" }); return null; }
  return id;
}

router.get("/targets/:id/projects", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  if (id === null) return;
  try { res.json(await remoteGet(id, "/control/v1/projects")); } catch (error) { handle(res, error); }
});

router.get("/targets/:id/projects/:projectId", requireAuth, async (req: Request<{ id: string; projectId: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  const projectId = id === null ? null : projectParam(req, res);
  if (id === null || projectId === null) return;
  try { res.json(await remoteGet(id, `/control/v1/projects/${projectId}`)); } catch (error) { handle(res, error); }
});

router.get("/targets/:id/projects/:projectId/deploys", requireAuth, async (req: Request<{ id: string; projectId: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  const projectId = id === null ? null : projectParam(req, res);
  if (id === null || projectId === null) return;
  try { res.json(await remoteGet(id, `/control/v1/projects/${projectId}/deploys`)); } catch (error) { handle(res, error); }
});

router.get("/targets/:id/projects/:projectId/logs", requireAuth, async (req: Request<{ id: string; projectId: string }>, res: Response): Promise<void> => {
  const id = idParam(req, res);
  const projectId = id === null ? null : projectParam(req, res);
  if (id === null || projectId === null) return;
  const query = parseLogQuery(req.query);
  if (!query) { res.status(400).json({ error: "Invalid service name" }); return; }
  const service = query.service ? `&service=${encodeURIComponent(query.service)}` : "";
  // Logs can hold secrets the application printed: they are shown, never kept.
  try { res.json(await remoteGet(id, `/control/v1/projects/${projectId}/logs?tail=${query.tail}${service}`, { cache: false })); } catch (error) { handle(res, error); }
});

/** Forgets a controller that was already revoked, with its stored key. */
router.delete("/controllers/:id/record", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = idParam(req, res);
  if (id === null) return;
  if (!deleteRevokedController(id)) { res.status(404).json({ error: "Controller not found, or not revoked yet" }); return; }
  auditLog(req.user ?? "unknown", "peer.controller.forget", String(id), "ok");
  res.status(204).end();
});

/** Revokes a controller's access here. Takes effect on its next request; it learns of it on its next check. */
router.delete("/controllers/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = idParam(req, res);
  if (id === null) return;
  if (!revokeController(id)) { res.status(404).json({ error: "Controller not found or already revoked" }); return; }
  auditLog(req.user ?? "unknown", "peer.controller.revoke", String(id), "ok");
  res.status(204).end();
});

// ── moving a project between instances ───────────────────────────────────────
// This instance is the controller; the source and the target are each this instance ("local") or a paired peer.

function refParam(value: unknown): EndpointRef | null {
  if (value === "local" || (value && typeof value === "object" && (value as { kind?: unknown }).kind === "local")) return { kind: "local" };
  const peerId = value && typeof value === "object" ? Number((value as { peerId?: unknown }).peerId) : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(peerId) && peerId > 0 ? { kind: "peer", peerId } : null;
}

router.get("/moves", requireAuth, (_req: Request, res: Response): void => { res.json({ moves: listMoves() }); });

/** The hostname step: the base domains the target's own domain manager holds and the names already taken there. */
router.get("/moves/domains/:target", requireAuth, async (req: Request<{ target: string }>, res: Response): Promise<void> => {
  const ref = refParam(req.params.target);
  if (!ref) { res.status(400).json({ error: "Invalid target" }); return; }
  try { res.json(await targetDomains(ref)); } catch (error) { handle(res, error); }
});

router.post("/moves", requireAuth, (req: Request, res: Response): void => {
  try {
    const source = refParam(req.body?.source);
    const target = refParam(req.body?.target);
    const projectId = Number(req.body?.projectId);
    if (!source || !target || typeof req.body?.projectName !== "string") throw new PeerError(400, "A source, a target, a project and its name are required.", "bad-request");
    const domains = Array.isArray(req.body?.domains) ? (req.body.domains as unknown[]).filter((d): d is { domain: string; service?: string; containerPort?: number | null } => typeof (d as { domain?: unknown })?.domain === "string") : [];
    const run = startMove({ source, target, projectId, projectName: req.body.projectName, name: typeof req.body?.name === "string" ? req.body.name : undefined, domains });
    auditLog(req.user ?? "unknown", "move.start", `${run.projectName}`, "ok", { moveRun: run.id });
    res.status(202).json(run);
  } catch (error) { handle(res, error); }
});

router.get("/moves/:id", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try { res.json(await getMoveRun(req.params.id)); } catch (error) { handle(res, error); }
});

router.post("/moves/:id/confirm", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try { auditLog(req.user ?? "unknown", "move.confirm", req.params.id, "ok"); res.json(await decide(req.params.id, "confirm")); } catch (error) { handle(res, error); }
});

router.post("/moves/:id/abort", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try { auditLog(req.user ?? "unknown", "move.abort", req.params.id, "ok"); res.json(await decide(req.params.id, "abort")); } catch (error) { handle(res, error); }
});

export default router;
