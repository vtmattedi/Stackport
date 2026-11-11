import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../identity/middleware/session";
import { auditLog } from "../../../shared/logger";
import { findMigration, getJob, ENCRYPTION_TASKS, startJob } from "./registry";
import type { MigrationMode } from "./types";

/** Admin-only control for the encryption tasks (Settings > Encryption). */
const router = Router();

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  res.json(ENCRYPTION_TASKS.map(({ id, title, description, executeWarning, destructive }) => ({ id, title, description, executeWarning, destructive: destructive === true, job: getJob(id) })));
});

for (const [path, mode] of [["dry-run", "dry-run"], ["execute", "execute"]] as [string, MigrationMode][]) {
  router.post(`/:id/${path}`, requireAuth, (req: Request<{ id: string }>, res: Response): void => {
    const migration = findMigration(req.params.id);
    if (!migration) { res.status(404).json({ error: "Unknown migration" }); return; }
    if (!startJob(migration, mode)) { res.status(409).json({ error: "This migration is already running" }); return; }
    auditLog(req.user ?? "unknown", `encryption-task.${mode}`, migration.id, "ok");
    res.status(202).json(getJob(migration.id));
  });
}

export default router;
