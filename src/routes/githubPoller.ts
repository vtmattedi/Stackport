import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { githubPoller } from "../services/githubPoller";
import { webhookBaseUrl } from "../services/githubWebhooks";

const router = Router();

router.get("/", requireAuth, (_req, res) => {
  const base = webhookBaseUrl();
  res.json({ ...githubPoller.getConfig(), webhookBaseUrl: base.url, webhookUnavailableReason: base.reason });
});

router.put("/", requireAuth, (req, res) => {
  const { enabled, credentialId, pollIntervalS, webhookSafetyCheck } = req.body as {
    enabled?: boolean;
    credentialId?: number | null;
    pollIntervalS?: number;
    webhookSafetyCheck?: boolean;
  };

  if (pollIntervalS !== undefined && (typeof pollIntervalS !== "number" || pollIntervalS < 60 || pollIntervalS > 86400)) {
    res.status(400).json({ error: "pollIntervalS must be between 60 and 86400" });
    return;
  }

  if (webhookSafetyCheck !== undefined && typeof webhookSafetyCheck !== "boolean") {
    res.status(400).json({ error: "webhookSafetyCheck must be a boolean" });
    return;
  }

  const updated = githubPoller.saveConfig({ enabled, credentialId, pollIntervalS, webhookSafetyCheck });
  const base = webhookBaseUrl();
  res.json({ ...updated, webhookBaseUrl: base.url, webhookUnavailableReason: base.reason });
});

router.post("/poll", requireAuth, (_req, res) => {
  void githubPoller.poll();
  res.json({ ok: true });
});

export default router;
