import { Router, Request, Response } from "express";
import { getDatabase } from "../../config/database";
import { requireAuth } from "../../modules/identity/middleware/session";
import { auditLog } from "../../shared/logger";
import { getNginxAppConfig } from "../../modules/ingress/nginx/configWriter";
import { getCertbotStatus } from "../../modules/ingress/certificates/operations";
import {
  ALL_MODULES, completeLink, completeManifest, GithubAppError, preflight, refreshRepositories, rotateAppCredentials, startLink, startManifest, syncInstallations,
  type ModuleName, type PreflightDeps,
} from "../../modules/github/app";
import { GithubError } from "../../modules/github/client";
import { getApp, getInstallation, listInstallations, listRepositories } from "../../modules/github/store";
import { inspectRepository, listRepositoryBranches, resolveAppRepository } from "../../modules/github/binding";
import { listDeliveries, replayDelivery } from "../../modules/github/webhook";

/**
 * Settings > GitHub. The three browser callbacks (`/manifest/callback`, `/oauth/callback`, `/setup`) are the only
 * unauthenticated routes: GitHub redirects the admin's browser to them, and the session cookie is SameSite=Strict, so
 * it is not sent. They are protected by a single-use, expiring `state` made during an authenticated request instead.
 */

const router = Router();

const realDeps: PreflightDeps = {
  appConfig: () => { const c = getNginxAppConfig(); return { enabled: c.enabled, domain: c.domain, useSsl: c.useSsl }; },
  hasCertificate: async (domain) => (await getCertbotStatus()).entries.some((entry) => entry.domain === domain && entry.hasCertificate),
};

function fail(res: Response, err: unknown): void {
  if (err instanceof GithubAppError) { res.status(err.status).json({ error: err.message }); return; }
  if (err instanceof GithubError) { res.status(502).json({ error: `GitHub answered: ${err.message}` }); return; }
  res.status(500).json({ error: "The GitHub request failed" });
}

/** Back to the settings page, which shows what happened. The message is ours, never GitHub's text. */
function backToSettings(res: Response, params: Record<string, string>): void {
  res.redirect(303, `/settings/github?${new URLSearchParams(params).toString()}`);
}

router.get("/", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const check = await preflight(realDeps);
    const app = getApp();
    res.json({
      preflight: check,
      modules: ALL_MODULES,
      app,
      // The URLs live in the App's settings on GitHub and cannot be changed from here; when the domain moves they are stale.
      domainDrift: app !== null && check.origin !== null && app.registeredOrigin !== check.origin,
      installations: listInstallations(),
    });
  } catch (err) { fail(res, err); }
});

router.post("/manifest/start", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const modules = Array.isArray(req.body?.modules) ? (req.body.modules as unknown[]).filter((m): m is ModuleName => ALL_MODULES.includes(m as ModuleName)) : ALL_MODULES;
  const owner = typeof req.body?.owner === "string" ? req.body.owner.trim() : "";
  try {
    const start = await startManifest(req.user ?? "unknown", { modules, owner, isPublic: req.body?.isPublic === true }, realDeps);
    auditLog(req.user ?? "unknown", "github-app.manifest.start", owner || "personal", "ok", { modules });
    res.json({ registrationUrl: start.registrationUrl, manifest: start.manifest, urls: start.urls });
  } catch (err) { fail(res, err); }
});

router.get("/manifest/callback", async (req: Request, res: Response): Promise<void> => {
  try {
    const app = await completeManifest(req.query["code"], req.query["state"], realDeps);
    auditLog("github", "github-app.registered", app.slug, "ok", { appId: app.appId, owner: app.ownerLogin });
    backToSettings(res, { registered: "1" });
  } catch (err) {
    auditLog("github", "github-app.registered", "-", "fail");
    backToSettings(res, { error: err instanceof GithubAppError ? err.message : "The registration could not be completed." });
  }
});

router.post("/link/start", requireAuth, (req: Request, res: Response): void => {
  try {
    res.json(startLink(req.user ?? "unknown"));
  } catch (err) { fail(res, err); }
});

router.get("/oauth/callback", async (req: Request, res: Response): Promise<void> => {
  try {
    const linked = await completeLink(req.query["code"], req.query["state"]);
    auditLog("github", "github-app.link", String(linked.length), "ok", { installations: linked.map((i) => i.accountLogin) });
    backToSettings(res, { linked: String(linked.length) });
  } catch (err) {
    auditLog("github", "github-app.link", "-", "fail");
    backToSettings(res, { error: err instanceof GithubAppError ? err.message : "The account could not be linked." });
  }
});

/** GitHub sends the admin here after installing the App. The installation id in the URL is not trusted (GitHub says it
 *  can be spoofed): it only returns the admin to the page, where **Connect an account** proves ownership. */
router.get("/setup", (_req: Request, res: Response): void => {
  backToSettings(res, { installed: "1" });
});

router.post("/installations/sync", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const installations = await syncInstallations();
    auditLog(req.user ?? "unknown", "github-app.sync", String(installations.length), "ok");
    res.json({ installations });
  } catch (err) { fail(res, err); }
});

router.get("/repositories", requireAuth, (req: Request, res: Response): void => {
  const installationId = req.query["installationId"] === undefined ? undefined : Number(req.query["installationId"]);
  if (installationId !== undefined && (!Number.isInteger(installationId) || installationId < 1)) { res.status(400).json({ error: "Invalid installation" }); return; }
  res.json({ repositories: listRepositories(installationId) });
});

/** The repository as the wizard picked it, checked against what the cache says the App can use. */
function repositoryFromRequest(req: Request<{ id: string }>) {
  const repositoryId = Number(req.params.id);
  const installationId = Number(req.query["installationId"]);
  return resolveAppRepository(installationId, repositoryId);
}

router.get("/repositories/:id/branches", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try { res.json({ branches: await listRepositoryBranches(repositoryFromRequest(req)) }); }
  catch (err) { fail(res, err); }
});

/** What is in a branch before it is cloned: its Compose files and the variable names in `.env.example`. */
router.get("/repositories/:id/inspect", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const branch = typeof req.query["branch"] === "string" ? req.query["branch"] : "";
  if (!branch || branch.length > 255) { res.status(400).json({ error: "Choose a branch." }); return; }
  try { res.json(await inspectRepository(repositoryFromRequest(req), branch)); }
  catch (err) { fail(res, err); }
});

/** Replaces the App's private key and/or webhook secret. The key is proved against GitHub first; nothing is returned. */
router.put("/credentials", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const rotated = await rotateAppCredentials({ privateKey: req.body?.privateKey, webhookSecret: req.body?.webhookSecret });
    auditLog(req.user ?? "unknown", "github-app.rotate", "-", "ok", rotated);
    res.json(rotated);
  } catch (err) {
    auditLog(req.user ?? "unknown", "github-app.rotate", "-", "fail");
    fail(res, err);
  }
});

router.get("/deliveries", requireAuth, (req: Request, res: Response): void => {
  res.json({ deliveries: listDeliveries(Number(req.query["limit"]) || 50) });
});

/** Handles a stored delivery again, for one that failed or was ignored for a reason that has since been fixed. */
router.post("/deliveries/:id/replay", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const status = replayDelivery(req.params.id);
  if (status === null) { res.status(404).json({ error: "Delivery not found" }); return; }
  auditLog(req.user ?? "unknown", "github-app.replay", req.params.id, status === "failed" ? "fail" : "ok", { status });
  res.json({ status, deliveries: listDeliveries(20) });
});

router.post("/installations/:id/refresh", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid installation" }); return; }
  if (!getInstallation(id)) { res.status(404).json({ error: "Installation not found" }); return; }
  try {
    const repositories = await refreshRepositories(id);
    auditLog(req.user ?? "unknown", "github-app.refresh", String(id), "ok", { repositories: repositories.length });
    res.json({ repositories: repositories.length, installation: getInstallation(id) });
  } catch (err) { fail(res, err); }
});

/** Forgets the App on this instance. It does not delete it on GitHub; the App's settings there say how. Refused while a
 *  project still deploys through it. */
router.delete("/", requireAuth, (req: Request, res: Response): void => {
  const using = getDatabase().prepare("SELECT COUNT(*) AS n FROM projects WHERE github_auth_mode = 'app'").get() as { n: number };
  if (using.n > 0) { res.status(409).json({ error: `${using.n} project${using.n === 1 ? "" : "s"} still deploy through the App. Move them to a token first.` }); return; }
  const db = getDatabase();
  db.transaction(() => {
    for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
  })();
  auditLog(req.user ?? "unknown", "github-app.forget", "-", "ok");
  res.status(204).end();
});

export default router;
