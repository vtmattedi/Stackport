import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import { findMigration, getJob, LEGACY_MIGRATIONS, startJob } from "./registry";
import type { MigrationMode } from "./types";

/** TEMPORARY (see types.ts): admin-only control for one-off migrations. */
const router = Router();

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  res.json(LEGACY_MIGRATIONS.map(({ id, title, description }) => ({ id, title, description, job: getJob(id) })));
});

for (const [path, mode] of [["dry-run", "dry-run"], ["execute", "execute"]] as [string, MigrationMode][]) {
  router.post(`/:id/${path}`, requireAuth, (req: Request<{ id: string }>, res: Response): void => {
    const migration = findMigration(req.params.id);
    if (!migration) { res.status(404).json({ error: "Unknown migration" }); return; }
    if (!startJob(migration, mode)) { res.status(409).json({ error: "This migration is already running" }); return; }
    auditLog(req.user ?? "unknown", `legacy-migration.${mode}`, migration.id, "ok");
    res.status(202).json(getJob(migration.id));
  });
}

export default router;
