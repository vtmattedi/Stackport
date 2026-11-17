import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { ensureInstanceIdentity } from "../backup/instance";
import { hasGrant, type Grant } from "./grants";
import { PeerError } from "./errors";
import { createGateway } from "./gateway";
import { parseLogQuery } from "../deployments/logQuery";
import { reportStatus } from "./peerStatus";
import { getRemoteProject, listRemoteProjects, remoteDeploys, remoteLogs } from "./remoteProjects";
import { acceptPairing } from "./service";
import { HEADERS, KEY_PATTERN, MAX_CLOCK_SKEW_MS, PROTOCOL_NAME, PROTOCOL_VERSIONS, safeEqual, signRequest, signResponse } from "./signing";
import { confirmControllerKey, controllerKeys, recordNonce, revokeController, rotateControllerKey, touchController, type Controller } from "./store";

declare global {
  namespace Express {
    interface Request {
      /** Set by the control channel once a request is authenticated: who is calling and what it may do here. */
      peer?: { controller: Controller; grants: Grant[]; operationId: string | null };
    }
  }
}


const DUMMY_KEY = "D".repeat(43);

/** Set when a backup is restored here (see backup/restore.ts); requests stamped before it are refused. */
function replayFloor(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'peer_replay_floor'").get() as { value: string } | undefined;
  return row ? Number(row.value) || 0 : 0;
}

function header(req: Request, name: string): string {
  return req.get(name) ?? "";
}

/** Authenticates a request on the managed side. Every refusal is decided here, before any handler runs. */
function authenticate(getDb: () => Database.Database): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const db = getDb();
    const self = ensureInstanceIdentity(db);
    const fail = (status: number, error: string, code: string): void => { res.status(status).json({ error, code }); };

    const versions = header(req, HEADERS.protocol).split(",").map((v) => Number(v.trim()));
    if (!versions.some((v) => PROTOCOL_VERSIONS.includes(v))) { fail(426, `Supported protocol versions: ${PROTOCOL_VERSIONS.join(", ")}.`, "version-mismatch"); return; }

    // The caller says which instance it means to reach. A different one answering (a moved address, a reused IP) must refuse rather than act.
    if (header(req, HEADERS.target) !== self.id) { fail(421, "This is not the instance the request was meant for.", "wrong-target"); return; }

    const callerId = header(req, HEADERS.instance);
    const timestamp = header(req, HEADERS.timestamp);
    const nonce = header(req, HEADERS.nonce);
    const signature = header(req, HEADERS.signature);
    const known = callerId ? controllerKeys(callerId, db) : null;
    const body = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signed = { method: req.method, path: req.originalUrl, from: callerId, to: self.id, timestamp, nonce, body };
    if (!known || !timestamp || !nonce || !signature || nonce.length > 64) {
      // Do the same work as for a real caller, so the answer's timing does not reveal which instance ids are paired.
      safeEqual(signature, signRequest(DUMMY_KEY, signed));
      fail(401, "Authentication failed.", "unauthenticated");
      return;
    }
    const usedKey = known.keys.find((key) => safeEqual(signature, signRequest(key, signed)));
    if (!usedKey) { fail(401, "Authentication failed.", "unauthenticated"); return; }

    // From here the caller has proved it holds the key, so every answer is signed (a refusal too, or it could not be told from a stranger's).
    // Signed where it is sent (res.end), so a body is covered however the handler produced it: res.json, res.send, or a bare end().
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.end = ((chunk?: unknown, encoding?: unknown, ...rest: unknown[]) => {
      if (!res.headersSent && !res.getHeader(HEADERS.responseSignature)) {
        const body = chunk === undefined || typeof chunk === "function" ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
        res.setHeader(HEADERS.responseSignature, signResponse(usedKey, nonce, res.statusCode, body));
      }
      return end(chunk, encoding, ...rest);
    }) as typeof res.end;

    // Only a caller that proved it holds the key learns it was revoked.
    if (known.controller.revokedAt) { fail(403, "This instance's access has been revoked.", "peer-revoked"); return; }
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > MAX_CLOCK_SKEW_MS) { fail(401, "The request's timestamp is outside the allowed window; check both clocks.", "clock-skew"); return; }
    // A restore starts with an empty nonce table: nothing signed before it may be accepted again.
    if (Number(timestamp) < replayFloor(db)) { fail(401, "This request predates a restore of this instance; sign it again.", "replay"); return; }
    if (!recordNonce(known.controller.id, nonce, db)) { fail(401, "This request was already received.", "replay"); return; }

    touchController(known.controller.id, db);
    // The controller is using the current key, so it holds it: a rotation is complete and the previous key can go.
    if (usedKey === known.keys[0] && known.keys.length > 1) confirmControllerKey(known.controller.id, db);
    req.peer = { controller: known.controller, grants: known.controller.grants, operationId: header(req, HEADERS.operation) || null };
    next();
  };
}

/** Handlers use this to demand a grant; a missing one is refused here and audited, never inferred from the caller. */
export function requireGrant(needed: Grant): RequestHandler {
  return (req, res, next) => {
    if (!req.peer || !hasGrant(req.peer.grants, needed)) {
      auditLog(`peer:${req.peer?.controller.instanceId ?? "unknown"}`, "peer.denied", `${req.method} ${req.path}`, "fail", { needed, operationId: req.peer?.operationId });
      res.status(403).json({ error: `This instance has not been granted ${needed}.`, code: "forbidden", needed });
      return;
    }
    next();
  };
}

/** For a route that any one of several grants opens; the refusal names all of them. */
export function requireAnyGrant(...accepted: Grant[]): RequestHandler {
  return (req, res, next) => {
    if (!req.peer || !accepted.some((grant) => hasGrant(req.peer?.grants ?? [], grant))) {
      auditLog(`peer:${req.peer?.controller.instanceId ?? "unknown"}`, "peer.denied", `${req.method} ${req.path}`, "fail", { needed: accepted, operationId: req.peer?.operationId });
      res.status(403).json({ error: `This instance has been granted none of: ${accepted.join(", ")}.`, code: "forbidden", needed: accepted });
      return;
    }
    next();
  };
}

/** Reads the body as exact bytes (the signature covers them) without interpreting it: parsing waits until the caller is authenticated. */
function readRaw(limit: string): RequestHandler[] {
  return [
    express.raw({ type: () => true, limit }),
    (req: Request, _res: Response, next: NextFunction): void => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      next();
    },
  ];
}

function parseBody(req: Request, res: Response, next: NextFunction): void {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  try { req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { res.status(400).json({ error: "The request body is not valid JSON.", code: "bad-request" }); return; }
  next();
}

/** The Stackport Control API (`sp-control/v1`), mounted at /control. Separate from the session-authenticated /api and from MCP.
 *  It must be mounted before the application's JSON parser: that parser would consume the body this router needs to see unparsed. */
export function createControlRouter(getDb: () => Database.Database = getDatabase, options: { api?: Router } = {}): Router {
  const router = Router();
  const pairLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many pairing attempts, try again later." } });
  const auth = authenticate(getDb);
  // The signature covers the body, so it has to be read before the caller is known: the limit is what a stranger can make this server hold,
  // and stays small. A route that must accept more (env files, uploads) will need its own bounded limit and a justification.
  const authed = [...readRaw("16kb"), auth, parseBody];

  // Presents a pairing code. Unauthenticated by design: the single-use secret is the credential, so it is rate limited.
  router.post("/v1/pair", pairLimiter, ...readRaw("16kb"), parseBody, (req: Request, res: Response): void => {
    try {
      res.json(acceptPairing({ secret: req.body?.secret, controller: { id: req.body?.controller?.id, name: req.body?.controller?.name } }, getDb()));
    } catch (error) {
      if (error instanceof PeerError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      throw error;
    }
  });

  /** Identity, current name and what this caller may do. Called on connect and periodically, which is how a rename reaches its controllers. */
  router.get("/v1/hello", ...authed, (req: Request, res: Response): void => {
    const self = ensureInstanceIdentity(getDb());
    res.json({ protocol: PROTOCOL_NAME, versions: PROTOCOL_VERSIONS, instance: self, grants: req.peer?.grants ?? [] });
  });

  /** The controller chooses the new key, so a lost answer is recovered by repeating the call. */
  router.post("/v1/rotate", ...authed, (req: Request, res: Response): void => {
    const controller = req.peer?.controller as Controller;
    if (typeof req.body?.key !== "string" || !KEY_PATTERN.test(req.body.key)) { res.status(400).json({ error: "A new key of 43 URL-safe characters is required.", code: "bad-request" }); return; }
    rotateControllerKey(controller.id, req.body.key, getDb());
    auditLog(`peer:${controller.instanceId}`, "peer.key-rotated", controller.instanceId, "ok", { operationId: req.peer?.operationId });
    res.json({ rotated: true });
  });

  /** The controller giving up its own access (it is being removed on its side). */
  router.post("/v1/revoke", ...authed, (req: Request, res: Response): void => {
    const controller = req.peer?.controller as Controller;
    revokeController(controller.id, getDb());
    auditLog(`peer:${controller.instanceId}`, "peer.released", controller.instanceId, "ok", { operationId: req.peer?.operationId });
    res.json({ revoked: true });
  });

  /** The live status stream's snapshot, cut to what this caller was granted. Either read grant opens it; neither gets nothing but a refusal. */
  router.get("/v1/status", ...authed, requireAnyGrant("host:read", "projects:read"), (req: Request, res: Response): void => {
    reportStatus(req.peer?.grants ?? []).then((report) => { res.json(report); }).catch((error: unknown) => {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "peer.status.read-failed");
      res.status(503).json({ error: "This instance could not collect its status.", code: "unavailable" });
    });
  });

  // ── the project API, for the requests the allow-list names ───────────────────
  // Only where the application's router was given (the real app); a bare control router, as in most tests, has no such route.
  if (options.api) router.use("/v1/api", ...authed, createGateway(options.api, getDb));

  // ── projects (read) ─────────────────────────────────────────────────────────
  // A curated summary (list, detail, deploys, logs) for lists, the sidebar and monitoring: built field by field, so a column added later is not shown by accident.
  // Operating on a project goes through the gateway above, which serves the application's own shapes. The two do not overlap on a path; what both must keep
  // (project-level actions only, masked env values) is decided in one place each: peerStatus.ts and gateway.ts.
  // Served from this instance's own services; the caller only reads. Mutations arrive with their own grants in later routes.
  const projectId = (req: Request, res: Response): number | null => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid project id.", code: "bad-request" }); return null; }
    return id;
  };
  const notFound = (res: Response): void => { res.status(404).json({ error: "Project not found.", code: "not-found" }); };
  const failed = (res: Response, error: unknown): void => {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "peer.projects.read-failed");
    res.status(500).json({ error: "This instance could not read the project.", code: "internal" });
  };

  router.get("/v1/projects", ...authed, requireGrant("projects:read"), async (_req: Request, res: Response): Promise<void> => {
    try { res.json({ projects: await listRemoteProjects() }); } catch (error) { failed(res, error); }
  });

  router.get("/v1/projects/:id", ...authed, requireGrant("projects:read"), async (req: Request, res: Response): Promise<void> => {
    const id = projectId(req, res);
    if (id === null) return;
    try {
      const project = await getRemoteProject(id);
      if (project) res.json(project); else notFound(res);
    } catch (error) { failed(res, error); }
  });

  router.get("/v1/projects/:id/deploys", ...authed, requireGrant("projects:read"), (req: Request, res: Response): void => {
    const id = projectId(req, res);
    if (id === null) return;
    const deploys = remoteDeploys(id);
    if (deploys) res.json({ deploys }); else notFound(res);
  });

  router.get("/v1/projects/:id/logs", ...authed, requireGrant("projects:read"), async (req: Request, res: Response): Promise<void> => {
    const id = projectId(req, res);
    if (id === null) return;
    const query = parseLogQuery(req.query);
    if (!query) { res.status(400).json({ error: "Invalid service name.", code: "bad-request" }); return; }
    try {
      const logs = await remoteLogs(id, query.tail, query.service);
      if (logs) res.json(logs); else notFound(res);
    } catch (error) { failed(res, error); }
  });

  router.use((_req: Request, res: Response): void => { res.status(404).json({ error: "Unknown control endpoint.", code: "not-found" }); });
  return router;
}

