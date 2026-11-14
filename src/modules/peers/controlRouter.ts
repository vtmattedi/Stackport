import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";
import { auditLog } from "../../shared/logger";
import { ensureInstanceIdentity } from "../backup/instance";
import { hasGrant, type Grant } from "./grants";
import { acceptPairing, PeerError } from "./service";
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
    if (!known || !timestamp || !nonce || !signature || nonce.length > 64) { fail(401, "Authentication failed.", "unauthenticated"); return; }

    const body = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signed = { method: req.method, path: req.originalUrl, from: callerId, to: self.id, timestamp, nonce, body };
    const usedKey = known.keys.find((key) => safeEqual(signature, signRequest(key, signed)));
    if (!usedKey) { fail(401, "Authentication failed.", "unauthenticated"); return; }

    // From here the caller has proved it holds the key, so every answer is signed (a refusal too, or it could not be told from a stranger's).
    res.json = (payload: unknown): Response => {
      const text = JSON.stringify(payload ?? null);
      res.setHeader(HEADERS.responseSignature, signResponse(usedKey, nonce, res.statusCode, Buffer.from(text)));
      res.type("application/json");
      return res.send(text);
    };

    // Only a caller that proved it holds the key learns it was revoked.
    if (known.controller.revokedAt) { fail(403, "This instance's access has been revoked.", "peer-revoked"); return; }
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > MAX_CLOCK_SKEW_MS) { fail(401, "The request's timestamp is outside the allowed window; check both clocks.", "clock-skew"); return; }
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

/** The Stackport Control API (`sp-control/v1`), mounted at /control. Separate from the session-authenticated /api and from MCP. */
export function createControlRouter(getDb: () => Database.Database = getDatabase): Router {
  const router = Router();
  // The channel reads its own body: the signature covers the exact bytes, whatever their type or size (env files will be large),
  // so this must not depend on the application's JSON parser and its 10 KB limit.
  router.use(express.raw({ type: () => true, limit: "5mb" }), (req: Request, res: Response, next: NextFunction): void => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    (req as Request & { rawBody?: Buffer }).rawBody = raw;
    try { req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { res.status(400).json({ error: "The request body is not valid JSON.", code: "bad-request" }); return; }
    next();
  });
  const pairLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many pairing attempts, try again later." } });
  const auth = authenticate(getDb);

  // Presents a pairing code. Unauthenticated by design: the single-use secret is the credential, so it is rate limited.
  router.post("/v1/pair", pairLimiter, (req: Request, res: Response): void => {
    try {
      res.json(acceptPairing({ secret: req.body?.secret, controller: { id: req.body?.controller?.id, name: req.body?.controller?.name } }, getDb()));
    } catch (error) {
      if (error instanceof PeerError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      throw error;
    }
  });

  /** Identity, current name and what this caller may do. Called on connect and periodically, which is how a rename reaches its controllers. */
  router.get("/v1/hello", auth, (req: Request, res: Response): void => {
    const self = ensureInstanceIdentity(getDb());
    res.json({ protocol: PROTOCOL_NAME, versions: PROTOCOL_VERSIONS, instance: self, grants: req.peer?.grants ?? [] });
  });

  /** The controller chooses the new key, so a lost answer is recovered by repeating the call. */
  router.post("/v1/rotate", auth, (req: Request, res: Response): void => {
    const controller = req.peer?.controller as Controller;
    if (typeof req.body?.key !== "string" || !KEY_PATTERN.test(req.body.key)) { res.status(400).json({ error: "A new key of 43 URL-safe characters is required.", code: "bad-request" }); return; }
    rotateControllerKey(controller.id, req.body.key, getDb());
    auditLog(`peer:${controller.instanceId}`, "peer.key-rotated", controller.instanceId, "ok", { operationId: req.peer?.operationId });
    res.json({ rotated: true });
  });

  /** The controller giving up its own access (it is being removed on its side). */
  router.post("/v1/revoke", auth, (req: Request, res: Response): void => {
    const controller = req.peer?.controller as Controller;
    revokeController(controller.id, getDb());
    auditLog(`peer:${controller.instanceId}`, "peer.released", controller.instanceId, "ok", { operationId: req.peer?.operationId });
    res.json({ revoked: true });
  });

  router.use((_req: Request, res: Response): void => { res.status(404).json({ error: "Unknown control endpoint.", code: "not-found" }); });
  return router;
}

export default createControlRouter();
