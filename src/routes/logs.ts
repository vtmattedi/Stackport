import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { queryAuditEntries } from "../utils/auditStore";

const router = Router();

function getQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

router.get("/", requireAuth, (req: Request, res: Response): void => {
  res.json(queryAuditEntries({
    actor: getQueryString(req.query["actor"]),
    action: getQueryString(req.query["action"]),
    target: getQueryString(req.query["target"]),
    from: getQueryString(req.query["from"]),
    to: getQueryString(req.query["to"]),
    page: getPositiveInteger(req.query["page"]),
    pageSize: getPositiveInteger(req.query["pageSize"]),
  }));
});

export default router;
