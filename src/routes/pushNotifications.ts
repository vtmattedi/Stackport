import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { deletePushSubscription, getPushConfig, listPushSubscriptions, resolvePushSubscription, savePushSubscription, sendWebPushNotification, updatePushConfig } from "../services/webPush";
import { getPushQueueStatus } from "../services/pushOutbox";
import { getDatabase } from "../config/database";

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.get("/config", (_req, res) => { res.json(getPushConfig()); });
router.get("/status", (_req, res) => {
  const config = getPushConfig();
  res.json({ enabled: config.enabled, identityError: config.identityError, ...getPushQueueStatus(getDatabase()) });
});
router.put("/config", (req, res) => {
  try { res.json(updatePushConfig(req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid push settings" }); }
});
router.get("/subscriptions", (_req, res) => { res.json(listPushSubscriptions()); });
router.post("/subscriptions/resolve", (req, res) => { res.json(resolvePushSubscription(req.body)); });
router.post("/subscriptions", (req, res) => {
  try { res.status(201).json(savePushSubscription(req.body, req.get("user-agent"))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid browser subscription" }); }
});
router.delete("/subscriptions/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid browser ID" }); return; }
  if (!deletePushSubscription(id)) { res.status(404).json({ error: "Browser not found" }); return; }
  res.json({ ok: true });
});
router.post("/test", async (req, res) => {
  if (!getPushConfig().enabled) { res.status(400).json({ error: "Enable and save browser push settings first" }); return; }
  const id = (req.body as { subscriptionId?: unknown } | undefined)?.subscriptionId;
  if (id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
    res.status(400).json({ error: "Invalid browser ID" }); return;
  }
  const results = await sendWebPushNotification({ type: "test", severity: "info", title: "Stackport browser push is ready",
    body: "This browser can receive important Stackport alerts, even when the tab is closed.",
    url: "/settings/notifications", createdAt: new Date().toISOString() }, { subscriptionId: id as number | undefined });
  if (!results.length) { res.status(400).json({ error: "Register a browser before sending a test" }); return; }
  res.json({ ok: results.every((result) => result.ok), results });
});

export default router;
