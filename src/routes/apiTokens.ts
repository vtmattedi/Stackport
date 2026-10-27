import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import { ApiTokenError, createApiToken, listApiTokens, revokeApiToken } from "../services/apiTokens";

/** Admin management of API tokens (session auth). The token value is returned only by
 *  POST, once; nothing else ever returns it. */
const router = Router();

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  res.json(listApiTokens());
});

router.post("/", requireAuth, (req: Request, res: Response): void => {
  try {
    const { token, record } = createApiToken({ name: req.body?.name, expiresInDays: req.body?.expiresInDays });
    auditLog(req.user ?? "unknown", "api-token.create", record.name, "ok", { tokenId: record.id, expiresAt: record.expiresAt });
    res.status(201).json({ token, record });
  } catch (err) {
    if (err instanceof ApiTokenError) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

router.delete("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!revokeApiToken(id)) { res.status(404).json({ error: "Token not found or already revoked" }); return; }
  auditLog(req.user ?? "unknown", "api-token.revoke", String(id), "ok");
  res.status(204).end();
});

export default router;
