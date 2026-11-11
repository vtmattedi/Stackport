import { Router, Request, Response } from "express";
import { requireAuth } from "../../modules/identity/middleware/session";
import { auditLog } from "../../shared/logger";
import { ProjectDomainError } from "../../modules/ingress/domains";
import { getCertbotStatus } from "../../modules/ingress/certificates/operations";
import { addManagedDomain, listHostnames, listManagedDomains, removeManagedDomain, setDefaultManagedDomain } from "../../modules/ingress/managedDomains";

/** The base domains Stackport manages. Only an admin session reaches these: an API token cannot add, remove or default one. */
const router = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof ProjectDomainError) { res.status(err.statusCode).json({ error: err.message }); return; }
  throw err;
}

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  res.json({ domains: listManagedDomains() });
});

/** Every hostname with its project, route, SSL state and certificate: the one place to see them all. */
router.get("/hostnames", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const certificates = await getCertbotStatus().then((s) => s.entries).catch(() => []);
  res.json({
    hostnames: listHostnames().map((h) => {
      const cert = certificates.find((c) => c.domain === h.domain);
      return { ...h, certificate: cert ? { status: cert.status, expiresAt: cert.expiresAt } : null };
    }),
  });
});

router.post("/", requireAuth, (req: Request, res: Response): void => {
  try {
    const domain = addManagedDomain(req.body?.name, req.body?.isDefault === true);
    auditLog(req.user ?? "unknown", "domain.add", domain.name, "ok", { isDefault: domain.isDefault });
    res.status(201).json({ domain, domains: listManagedDomains() });
  } catch (err) { fail(res, err); }
});

router.patch("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (req.body?.isDefault !== true) { res.status(400).json({ error: "isDefault must be true: make another domain the default to change it" }); return; }
  const domain = setDefaultManagedDomain(id);
  if (!domain) { res.status(404).json({ error: "Domain not found" }); return; }
  auditLog(req.user ?? "unknown", "domain.default", domain.name, "ok");
  res.json({ domain, domains: listManagedDomains() });
});

router.delete("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    if (!removeManagedDomain(id)) { res.status(404).json({ error: "Domain not found" }); return; }
    auditLog(req.user ?? "unknown", "domain.remove", String(id), "ok");
    res.json({ domains: listManagedDomains() });
  } catch (err) { fail(res, err); }
});

export default router;
