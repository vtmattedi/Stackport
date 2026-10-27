import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { actionRegistry } from "../services/actionRegistry";
import { readActionLog } from "../services/actionLog";
import { actionSummary } from "../services/realtime";

const router = Router();
const ACTION_ID_RE = /^(?:[0-9a-f-]{36}|legacy-[0-9]+)$/;

/** Every action running right now, without logs. */
router.get("/running", requireAuth, (_req: Request, res: Response): void => {
  res.json(actionRegistry.running().map(actionSummary));
});

/** An action's stored output (masked when it was written), as plain text. */
router.get("/:id/log", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  if (!ACTION_ID_RE.test(req.params.id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const text = readActionLog(req.params.id);
  if (text === null) { res.status(404).json({ error: "No stored log for this action (it may have been deleted by retention)" }); return; }
  res.type("text/plain").send(text);
});

export default router;
