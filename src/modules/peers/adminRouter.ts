import { Router, type Request, type Response } from "express";
import { requireAuth } from "../identity/middleware/session";
import { auditLog } from "../../shared/logger";
import { ensureInstanceIdentity, setInstanceName } from "../backup/instance";
import { GRANTS, GrantError } from "./grants";
import { checkPeer, forgetPeer, peerStatus } from "./monitor";
import { issuePairingCode, PeerError, registerTarget, removeTargetAndNotify, rotateTargetKey } from "./service";
import { listControllers, listTargets, revokeController } from "./store";

/** Admin management of peers from this instance's own UI (session auth). Pairing codes and keys are never listed: a code is shown once at creation, a key never. */
const router = Router();

function idParam(req: Request<{ id: string }>, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return null; }
  return id;
}

function handle(res: Response, error: unknown): void {
  if (error instanceof PeerError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof GrantError) { res.status(400).json({ error: error.message, code: "bad-grants" }); return; }
  if (error instanceof Error && /pairing code lasts|peer endpoint|instance name/i.test(error.message)) { res.status(400).json({ error: error.message }); return; }
  throw error;
}

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  res.json({
    self: ensureInstanceIdentity(),
    grantsAvailable: GRANTS,
    controlling: listTargets().map((target) => ({ ...target, status: peerStatus(target.id) ?? { state: "unknown" } })),
    controlledBy: listControllers(),
  });
});

router.put("/self", requireAuth, (req: Request, res: Response): void => {
  try {
    const self = setInstanceName(String(req.body?.name ?? ""));
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
    auditLog(req.user ?? "unknown", "peer.remove", String(id), "ok", { notified });
    res.json({ notified });
  } catch (error) { handle(res, error); }
});

/** Revokes a controller's access here. Takes effect on its next request; it learns of it on its next check. */
router.delete("/controllers/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = idParam(req, res);
  if (id === null) return;
  if (!revokeController(id)) { res.status(404).json({ error: "Controller not found or already revoked" }); return; }
  auditLog(req.user ?? "unknown", "peer.controller.revoke", String(id), "ok");
  res.status(204).end();
});

export default router;
