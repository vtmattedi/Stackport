import fs from "fs";
import { Router, type Request, type Response } from "express";
import { auditLog, logger } from "../../shared/logger";
import { requireAuth } from "../../modules/identity/middleware/session";
import { FullBackupError, deleteFullBackup, fullBackupFile, getFullBackup, listFullBackups, startFullBackup } from "../../modules/backup/fullBackup";
import { RestoreError, cancelRestore, confirmFull, finishProjects, inspectFull, receiveUpload, restoreStatus } from "../../modules/backup/fullRestore";

/** A full backup of this instance (settings, secrets and every project's data) to download, and a full restore from an uploaded one. The admin's session only: a paired
 *  controller has no rule for these paths, so the control channel's default-deny never reaches them. */
const router = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof FullBackupError || error instanceof RestoreError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "full-backup.route-failed");
  res.status(500).json({ error: "This instance could not complete the request.", code: "internal" });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

// ── a full backup of this instance ─────────────────────────────────────────
router.get("/full", requireAuth, (_req, res) => { res.json({ backups: listFullBackups() }); });
router.post("/full", requireAuth, async (req: Request, res: Response) => {
  try { const started = await startFullBackup(text(req.body?.passphrase)); res.status(202).json(started); } catch (error) { fail(res, error); }
});
router.get("/full/:id", requireAuth, (req: Request<{ id: string }>, res: Response) => {
  const found = getFullBackup(req.params.id);
  if (!found) { res.status(404).json({ error: "Backup not found." }); return; }
  res.json(found);
});
router.get("/full/:id/download", requireAuth, (req: Request<{ id: string }>, res: Response) => {
  const file = fullBackupFile(req.params.id);
  if (!file) { res.status(404).json({ error: "That backup is not available (it is kept for 24 hours)." }); return; }
  auditLog(req.user ?? "unknown", "full-backup.download", file.name, "ok");
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("content-length", String(file.size));
  res.setHeader("content-disposition", `attachment; filename="${file.name}"`);
  res.setHeader("cache-control", "no-store");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path comes from fullBackupFile: a name Stackport generated, inside its own backups directory.
  fs.createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
});
router.delete("/full/:id", requireAuth, (req: Request<{ id: string }>, res: Response) => {
  if (!getFullBackup(req.params.id)) { res.status(404).json({ error: "Backup not found." }); return; }
  if (!deleteFullBackup(req.params.id)) { res.status(409).json({ error: "The backup is still running or its projects are awaiting recovery." }); return; }
  res.json({ ok: true });
});

// ── restore a full backup on this instance ─────────────────────────────────
router.get("/restore", requireAuth, async (_req, res) => {
  try { res.json(await restoreStatus()); } catch (error) { fail(res, error); }
});
router.put("/restore/upload", requireAuth, async (req: Request, res: Response) => {
  try {
    const length = Number(req.get("content-length"));
    const result = await receiveUpload(req, Number.isFinite(length) && length > 0 ? length : null);
    auditLog(req.user ?? "unknown", "full-restore.upload", "backup", "ok", { size: result.size });
    res.json(result);
  } catch (error) { fail(res, error); }
});
router.post("/restore/inspect", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await inspectFull(text(req.body?.passphrase))); } catch (error) { fail(res, error); }
});
router.post("/restore/confirm", requireAuth, async (req: Request, res: Response) => {
  try { res.status(202).json(await confirmFull({ passphrase: text(req.body?.passphrase), mode: text(req.body?.mode) as "recover" | "clone", confirm: text(req.body?.confirm) })); } catch (error) { fail(res, error); }
});
router.post("/restore/projects", requireAuth, async (req: Request, res: Response) => {
  try { res.status(202).json(await finishProjects(text(req.body?.passphrase))); } catch (error) { fail(res, error); }
});
router.delete("/restore", requireAuth, (_req, res) => {
  try { cancelRestore(); res.json({ ok: true }); } catch (error) { fail(res, error); }
});

export default router;
