import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import {
  addMonitoredVm,
  listAvailableVms,
  refreshMonitoredVms,
  refreshVm,
  removeMonitoredVm,
  refreshAndSnapshot,
  resetVm,
  snapshot,
  upsertHostingerProvider,
  VpsSnapshot,
  createFirewallProfile,
  createFirewallRule,
  deleteFirewallProfile,
  deleteFirewallRule,
  getProviderFirewall,
  listFirewallProfiles,
  listProviderFirewalls,
  syncFirewallProfile,
  updateFirewallProfile,
} from "../services/vps";

const router = Router();

function handleError(res: Response, err: unknown): void {
  const e = err as { status?: number; body?: unknown; message?: string };
  res.status(e.status ?? 502).json(e.body ?? { error: e.message ?? "Unknown error" });
}

router.get("/", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await snapshot());
});

function saveHostingerProvider(req: Request, res: Response, options: Record<string, unknown>): void {
  const { id, name, credentialId, type } = options;
  if (type != null && type !== "hostinger") {
    res.status(400).json({ error: "Unsupported VPS provider type" });
    return;
  }
  const providerId = id == null || id === ""
    ? undefined
    : typeof id === "number"
      ? id
      : Number(id);
  if (providerId !== undefined && (!Number.isInteger(providerId) || providerId <= 0)) {
    res.status(400).json({ error: "Invalid VPS provider id" });
    return;
  }
  let parsedCredentialId: number | null | undefined;
  if (credentialId === undefined) {
    parsedCredentialId = undefined;
  } else if (credentialId === null) {
    parsedCredentialId = null;
  } else {
    const num = typeof credentialId === "number" ? credentialId : Number(credentialId);
    if (!Number.isInteger(num) || num <= 0) {
      res.status(400).json({ error: "Invalid credentialId" });
      return;
    }
    parsedCredentialId = num;
  }
  try {
    const provider = upsertHostingerProvider(
      typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "Hostinger",
      parsedCredentialId,
      providerId
    );
    auditLog(req.user ?? "unknown", "vps.provider-upsert", provider.name, "ok");
    res.status(201).json(provider);
  } catch (err) {
    handleError(res, err);
  }
}

router.post("/", requireAuth, (req: Request, res: Response): void => {
  const { action, options } = req.body as Record<string, unknown>;
  if (action !== "create") {
    res.status(400).json({ error: "Unsupported VPS action" });
    return;
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    res.status(400).json({ error: "options is required" });
    return;
  }
  saveHostingerProvider(req, res, options as Record<string, unknown>);
});

router.get("/providers/:providerId/vms", requireAuth, async (req: Request<{ providerId: string }>, res: Response): Promise<void> => {
  const providerId = parseInt(req.params.providerId, 10);
  if (isNaN(providerId)) { res.status(400).json({ error: "Invalid provider id" }); return; }
  try {
    res.json(await listAvailableVms(providerId));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/providers/:providerId/firewalls", requireAuth, async (req: Request<{ providerId: string }>, res: Response): Promise<void> => {
  const providerId = parseInt(req.params.providerId, 10);
  if (isNaN(providerId)) { res.status(400).json({ error: "Invalid provider id" }); return; }
  try {
    res.json(await listProviderFirewalls(providerId));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/providers/:providerId/firewalls/:firewallId", requireAuth, async (req: Request<{ providerId: string; firewallId: string }>, res: Response): Promise<void> => {
  const providerId = parseInt(req.params.providerId, 10);
  if (isNaN(providerId)) { res.status(400).json({ error: "Invalid provider id" }); return; }
  try {
    res.json(await getProviderFirewall(providerId, req.params.firewallId));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/firewall/profiles", requireAuth, (req: Request, res: Response): void => {
  const providerId = req.query.providerId == null ? undefined : Number(req.query.providerId);
  if (providerId !== undefined && (!Number.isInteger(providerId) || providerId <= 0)) {
    res.status(400).json({ error: "Invalid provider id" });
    return;
  }
  res.json(listFirewallProfiles(providerId));
});

router.post("/firewall/profiles", requireAuth, (req: Request, res: Response): void => {
  const { providerId, name, remoteFirewallId } = req.body as Record<string, unknown>;
  const parsedProviderId = typeof providerId === "number" ? providerId : Number(providerId);
  if (!Number.isInteger(parsedProviderId) || parsedProviderId <= 0) {
    res.status(400).json({ error: "providerId is required" });
    return;
  }
  try {
    const profile = createFirewallProfile(
      parsedProviderId,
      typeof name === "string" ? name : "Stackport Firewall",
      typeof remoteFirewallId === "string" ? remoteFirewallId : null
    );
    auditLog(req.user ?? "unknown", "firewall.profile-create", String(profile.id), "ok");
    res.status(201).json(profile);
  } catch (err) {
    handleError(res, err);
  }
});

router.patch("/firewall/profiles/:profileId", requireAuth, (req: Request<{ profileId: string }>, res: Response): void => {
  const profileId = parseInt(req.params.profileId, 10);
  if (isNaN(profileId)) { res.status(400).json({ error: "Invalid profile id" }); return; }
  const { name, remoteFirewallId } = req.body as Record<string, unknown>;
  try {
    const profile = updateFirewallProfile(profileId, {
      ...(typeof name === "string" ? { name } : {}),
      ...(remoteFirewallId === null || typeof remoteFirewallId === "string" ? { remoteFirewallId } : {}),
    });
    auditLog(req.user ?? "unknown", "firewall.profile-update", String(profile.id), "ok");
    res.json(profile);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/firewall/profiles/:profileId", requireAuth, (req: Request<{ profileId: string }>, res: Response): void => {
  const profileId = parseInt(req.params.profileId, 10);
  if (isNaN(profileId)) { res.status(400).json({ error: "Invalid profile id" }); return; }
  if (!deleteFirewallProfile(profileId)) {
    res.status(404).json({ error: "Firewall profile not found" });
    return;
  }
  auditLog(req.user ?? "unknown", "firewall.profile-delete", String(profileId), "ok");
  res.status(204).send();
});

router.post("/firewall/profiles/:profileId/rules", requireAuth, (req: Request<{ profileId: string }>, res: Response): void => {
  const profileId = parseInt(req.params.profileId, 10);
  if (isNaN(profileId)) { res.status(400).json({ error: "Invalid profile id" }); return; }
  try {
    const rule = createFirewallRule(profileId, req.body as Record<string, unknown>);
    auditLog(req.user ?? "unknown", "firewall.rule-create", String(rule.id), "ok");
    res.status(201).json(rule);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/firewall/profiles/:profileId/rules/:ruleId", requireAuth, (req: Request<{ profileId: string; ruleId: string }>, res: Response): void => {
  const profileId = parseInt(req.params.profileId, 10);
  const ruleId = parseInt(req.params.ruleId, 10);
  if (isNaN(profileId) || isNaN(ruleId)) { res.status(400).json({ error: "Invalid firewall rule id" }); return; }
  if (!deleteFirewallRule(profileId, ruleId)) {
    res.status(404).json({ error: "Firewall rule not found" });
    return;
  }
  auditLog(req.user ?? "unknown", "firewall.rule-delete", String(ruleId), "ok");
  res.status(204).send();
});

router.post("/firewall/profiles/:profileId/sync", requireAuth, async (req: Request<{ profileId: string }>, res: Response): Promise<void> => {
  const profileId = parseInt(req.params.profileId, 10);
  if (isNaN(profileId)) { res.status(400).json({ error: "Invalid profile id" }); return; }
  const { vmId, activate } = req.body as Record<string, unknown>;
  try {
    const result = await syncFirewallProfile(profileId, {
      vmId: typeof vmId === "string" && vmId.trim() ? vmId.trim() : null,
      activate: activate === true,
    });
    auditLog(req.user ?? "unknown", "firewall.sync", String(profileId), "ok");
    res.json(result);
  } catch (err) {
    auditLog(req.user ?? "unknown", "firewall.sync", String(profileId), "fail");
    handleError(res, err);
  }
});

router.post("/monitored", requireAuth, (req: Request, res: Response): void => {
  const { providerId, vmId, label } = req.body as Record<string, unknown>;
  const parsedProviderId = typeof providerId === "number" ? providerId : Number(providerId);
  if (!Number.isInteger(parsedProviderId) || parsedProviderId <= 0 || typeof vmId !== "string" || vmId.trim() === "") {
    res.status(400).json({ error: "providerId and vmId are required" });
    return;
  }
  const monitored = addMonitoredVm(
    parsedProviderId,
    vmId.trim(),
    typeof label === "string" && label.trim() ? label.trim().slice(0, 100) : null
  );
  auditLog(req.user ?? "unknown", "vps.monitor-add", monitored.vmId, "ok");
  res.status(201).json(monitored);
});

router.delete("/monitored/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!removeMonitoredVm(id)) {
    res.status(404).json({ error: "Monitored VM not found" });
    return;
  }
  auditLog(req.user ?? "unknown", "vps.monitor-remove", String(id), "ok");
  res.status(204).send();
});

router.post("/refresh", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ vms: await refreshMonitoredVms() });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/providers/:providerId/vms/:vmId/refresh", requireAuth, async (req: Request<{ providerId: string; vmId: string }>, res: Response): Promise<void> => {
  const providerId = parseInt(req.params.providerId, 10);
  if (isNaN(providerId)) { res.status(400).json({ error: "Invalid provider id" }); return; }
  try {
    res.json(await refreshVm(providerId, req.params.vmId));
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/providers/:providerId/vms/:vmId/reset", requireAuth, async (req: Request<{ providerId: string; vmId: string }>, res: Response): Promise<void> => {
  const providerId = parseInt(req.params.providerId, 10);
  if (isNaN(providerId)) { res.status(400).json({ error: "Invalid provider id" }); return; }
  try {
    const result = await resetVm(providerId, req.params.vmId);
    auditLog(req.user ?? "unknown", "vps.reset", req.params.vmId, "ok");
    res.json(result ?? { ok: true });
  } catch (err) {
    auditLog(req.user ?? "unknown", "vps.reset", req.params.vmId, "fail");
    handleError(res, err);
  }
});

router.post("/reset", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const data = await snapshot();
  const vm = data.monitored[0];
  if (!vm) { res.status(404).json({ error: "No monitored VM configured" }); return; }
  try {
    res.json(await resetVm(vm.providerId, vm.vmId));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/debug", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await snapshot());
});

router.get("/info", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await snapshot());
});

router.get("/metrics", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await snapshot());
});

export default router;

export async function fetchVpsSnapshot(): Promise<VpsSnapshot> {
  try {
    return await snapshot();
  } catch {
    return { configured: false, providers: [], monitored: [], vms: [], vps: null };
  }
}

export async function refreshVpsSnapshot(): Promise<VpsSnapshot> {
  try {
    return await refreshAndSnapshot();
  } catch {
    return { configured: false, providers: [], monitored: [], vms: [], vps: null };
  }
}
