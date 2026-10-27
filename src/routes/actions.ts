import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { getDatabase } from "../config/database";
import { actionRegistry } from "../services/actionRegistry";
import { readActionLog } from "../services/actionLog";
import { actionSummary } from "../services/realtime";

const router = Router();
const ACTION_ID_RE = /^(?:[0-9a-f-]{36}|legacy-[0-9]+)$/;

/** Every action running right now, without logs. */
router.get("/running", requireAuth, (_req: Request, res: Response): void => {
  res.json(actionRegistry.running().map(actionSummary));
});

interface ActionRow {
  id: string;
  key: string;
  kind: string;
  project_id: number | null;
  status: string;
  triggered_by: string;
  commit_sha: string | null;
  branch: string | null;
  started_at: string;
  finished_at: string | null;
}

/** One action's record, without its log: from memory while it is the latest on its
 *  slot (with live progress), else from the actions table. */
router.get("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  if (!ACTION_ID_RE.test(req.params.id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const live = actionRegistry.getById(req.params.id);
  if (live) { res.json(actionSummary(live)); return; }
  const row = getDatabase().prepare("SELECT * FROM actions WHERE id = ?").get(req.params.id) as ActionRow | undefined;
  if (!row) { res.status(404).json({ error: "Action not found" }); return; }
  res.json({
    id: row.id,
    key: row.key,
    kind: row.kind,
    projectId: row.project_id ?? undefined,
    meta: { triggeredBy: row.triggered_by, commitSha: row.commit_sha, branch: row.branch },
    status: row.status === "success" ? "success" : row.status === "running" ? "running" : "failed",
    ok: row.status === "success" ? true : row.status === "running" ? null : false,
    startedAt: row.started_at,
    completedAt: row.finished_at,
    phase: null,
    progress: null,
  });
});

/** An action's stored output (masked when it was written), as plain text. */
router.get("/:id/log", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  if (!ACTION_ID_RE.test(req.params.id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const text = readActionLog(req.params.id);
  if (text === null) { res.status(404).json({ error: "No stored log for this action (it may have been deleted by retention)" }); return; }
  res.type("text/plain").send(text);
});

export default router;
