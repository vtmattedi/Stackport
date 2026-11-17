import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import rateLimit from "express-rate-limit";
import type Database from "better-sqlite3";
import { logger } from "../../shared/logger";
import { MoveError, abortMove, beginMove, commitMove, getMove, renewMove } from "../moves/moveOut";
import { CHUNK_MAX_BYTES, TransferError, abortTransfer, authorizeTicket, commitTransfer, completeTransfer, domainOptions, getTransfer, keepAlive, prepareTransfer, projectHealth, receiveChunk, startImport, startImported } from "../moves/transferIn";
import type { Grant } from "./grants";

/** The routes a move uses on this instance, as target. The paired controller's routes sit behind its signature and grants; the two the source uses
 *  (chunks, complete) are reached by a ticket's token alone, outside the signature, and are bounded by it: one transfer, one hour. */
function failure(res: Response, error: unknown): void {
  if (error instanceof TransferError || error instanceof MoveError) { res.status(error.status).json({ error: error.message, code: error.code, ...error.extra }); return; }
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "peer.moves.failed");
  res.status(500).json({ error: "This instance could not complete the request.", code: "internal" });
}

const controller = (req: Request): string => req.peer?.controller.instanceId ?? "";

/** Moving needs the transfer grant AND secrets (the archive carries them): a grant list edited by hand cannot leave one out. */
export function attachTargetRoutes(router: Router, authed: RequestHandler[], requireGrant: (needed: Grant) => RequestHandler, getDb: () => Database.Database): void {
  // projects:transfer carries projects:secrets with it (grants.ts), so holding it is enough.
  const requireTransfer = requireGrant("projects:transfer");
  const wrap = (fn: (req: Request, res: Response, db: Database.Database) => unknown | Promise<unknown>): RequestHandler => (req, res) => {
    Promise.resolve().then(() => fn(req, res, getDb())).catch((error: unknown) => failure(res, error));
  };

  // Where the "new hostname" step looks: the base domains this instance manages and the hostnames already taken.
  router.get("/v1/domains", ...authed, requireTransfer, wrap((_req, res, db) => { res.json(domainOptions(db)); }));

  router.post("/v1/transfers", ...authed, requireTransfer, wrap((req, res, db) => {
    const domains = Array.isArray(req.body?.domains) ? (req.body.domains as unknown[]).filter((d): d is { domain: string; service?: string; containerPort?: number | null } => typeof (d as { domain?: unknown })?.domain === "string") : [];
    res.status(201).json(prepareTransfer({ controllerInstance: controller(req), name: req.body?.name, domains }, db));
  }));
  router.get("/v1/transfers/:id", ...authed, requireTransfer, wrap((req, res, db) => { res.json(getTransfer(String(req.params["id"]), controller(req), db)); }));
  router.post("/v1/transfers/:id/keepalive", ...authed, requireTransfer, wrap((req, res, db) => { res.json(keepAlive(String(req.params["id"]), controller(req), db)); }));
  router.post("/v1/transfers/:id/import", ...authed, requireTransfer, wrap((req, res, db) => { res.json(startImport(String(req.params["id"]), controller(req), db)); }));
  router.post("/v1/transfers/:id/start", ...authed, requireTransfer, wrap((req, res, db) => { res.json(startImported(String(req.params["id"]), controller(req), db)); }));
  router.get("/v1/transfers/:id/health", ...authed, requireTransfer, wrap(async (req, res, db) => { res.json(await projectHealth(String(req.params["id"]), controller(req), db)); }));
  router.post("/v1/transfers/:id/commit", ...authed, requireTransfer, wrap((req, res, db) => { res.json(commitTransfer(String(req.params["id"]), controller(req), db)); }));
  router.post("/v1/transfers/:id/abort", ...authed, requireTransfer, wrap(async (req, res, db) => { res.json(await abortTransfer(String(req.params["id"]), controller(req), db)); }));

  // ── this instance as the source of a move ────────────────────────────────────
  router.post("/v1/moves", ...authed, requireTransfer, wrap(async (req, res, db) => {
    const body = req.body as { projectId?: unknown; ticket?: unknown; archiveKey?: unknown };
    if (!Number.isInteger(body.projectId)) throw new MoveError(400, "projectId is required.", "bad-request");
    res.status(202).json(await beginMove({ controllerInstance: controller(req), projectId: body.projectId as number, ticket: body.ticket as never, archiveKey: body.archiveKey as string }, db));
  }));
  router.get("/v1/moves/:id", ...authed, requireTransfer, wrap((req, res, db) => { res.json(getMove(String(req.params["id"]), controller(req), db)); }));
  router.post("/v1/moves/:id/renew", ...authed, requireTransfer, wrap((req, res, db) => { res.json(renewMove(String(req.params["id"]), controller(req), db, typeof req.body?.holdMs === "number" ? req.body.holdMs : undefined)); }));
  router.post("/v1/moves/:id/abort", ...authed, requireTransfer, wrap(async (req, res, db) => { res.json(await abortMove(String(req.params["id"]), controller(req), db)); }));
  // Destroying the source is its own grant, never implied by the transfer.
  router.post("/v1/moves/:id/commit", ...authed, requireTransfer, requireGrant("projects:destroy"), wrap(async (req, res, db) => {
    if (typeof req.body?.digest !== "string") throw new MoveError(400, "The digest is required.", "bad-request");
    res.json(await commitMove(String(req.params["id"]), controller(req), req.body.digest, db));
  }));

  // ── the source's side of a ticket: no signature, only the token ─────────────
  // Wrong tokens count against the caller; a stream of good chunks does not.
  const ticketLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, requestWasSuccessful: (_req, res) => res.statusCode !== 401 && res.statusCode !== 410, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many failed attempts.", code: "rate-limited" } });
  const token = (req: Request): string => /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(req.get("authorization") ?? "")?.[1] ?? "";
  const rawChunk = express.raw({ type: () => true, limit: CHUNK_MAX_BYTES });
  const noStore: RequestHandler = (_req: Request, res: Response, next: NextFunction) => { res.setHeader("cache-control", "no-store"); next(); };

  router.get("/transfer/:id", noStore, ticketLimiter, wrap((req, res, db) => {
    // Authentication happens in receiveChunk/complete; the state read is for resuming, and shows only counters.
    const id = String(req.params["id"]);
    const probe = receiveProbe(id, token(req), db);
    res.json(probe);
  }));
  router.put("/transfer/:id/chunks/:n", noStore, ticketLimiter, rawChunk, wrap((req, res, db) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.json(receiveChunk(String(req.params["id"]), token(req), Number(req.params["n"]), String(req.get("x-sp-chunk-sha256") ?? ""), bytes, db));
  }));
  router.post("/transfer/:id/complete", noStore, ticketLimiter, express.json({ limit: "4kb" }), wrap(async (req, res, db) => {
    const body = req.body as { chunks?: unknown; size?: unknown; sha256?: unknown };
    if (!Number.isInteger(body.chunks) || !Number.isInteger(body.size) || typeof body.sha256 !== "string") throw new TransferError(400, "chunks, size and sha256 are required.", "bad-request");
    res.json(await completeTransfer(String(req.params["id"]), token(req), { chunks: body.chunks as number, size: body.size as number, sha256: body.sha256 }, db));
  }));
}

function receiveProbe(id: string, tokenValue: string, db: Database.Database): { state: string; next: number; received: number } {
  const r = authorizeTicket(id, tokenValue, db);
  return { state: r.state, next: r.next_chunk, received: r.received_bytes };
}
