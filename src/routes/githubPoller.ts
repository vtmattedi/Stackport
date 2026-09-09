import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { githubPoller } from "../services/githubPoller";

const router = Router();

router.get("/", requireAuth, (_req, res) => {
  res.json(githubPoller.getConfig());
});

router.put("/", requireAuth, (req, res) => {
  const { enabled, credentialId, pollIntervalS } = req.body as {
    enabled?: boolean;
    credentialId?: number | null;
    pollIntervalS?: number;
  };

  if (pollIntervalS !== undefined && (typeof pollIntervalS !== "number" || pollIntervalS < 60 || pollIntervalS > 86400)) {
    res.status(400).json({ error: "pollIntervalS must be between 60 and 86400" });
    return;
  }

  const updated = githubPoller.saveConfig({ enabled, credentialId, pollIntervalS });
  res.json(updated);
});

router.post("/poll", requireAuth, (_req, res) => {
  void githubPoller.poll();
  res.json({ ok: true });
});

export default router;
