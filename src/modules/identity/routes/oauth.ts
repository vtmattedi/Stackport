import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/session";
import { auditLog } from "../../../shared/logger";
import { listApiProjectGroupNames } from "../oauth/groups";
import { approvePendingRequest, denyPendingRequest, disconnectApp, getPendingRequest, isLoopbackRedirect, listConnectedApps, redirectUriProblem, takePendingRequest, type Grant } from "../oauth/provider";
import type { ApiTokenScope } from "../apiTokens";

/** The admin's side of OAuth for MCP (session auth): what a client is asking for, approve or deny it, and the apps already connected. */
const router = Router();

function requestId(req: Request<{ id: string }>): string {
  return typeof req.params.id === "string" ? req.params.id : "";
}

/** What the admin should recognise: the host of a web address, or the scheme of an app link. */
function redirectHostOf(uri: string): string {
  const url = new URL(uri);
  return url.host || url.protocol;
}

function parseGrant(body: unknown): Grant | string {
  const input = (body ?? {}) as { scope?: unknown; logs?: unknown; projectGroup?: unknown };
  if (input.scope !== "read" && input.scope !== "write") return 'scope must be "read" or "write"';
  if (input.logs !== undefined && typeof input.logs !== "boolean") return "logs must be true or false";
  const scopes: ApiTokenScope[] = input.scope === "write" ? ["read", "write"] : ["read"];
  if (input.logs === true) scopes.push("logs");
  let projectGroup: string | null = null;
  if (input.projectGroup !== undefined && input.projectGroup !== null && input.projectGroup !== "") {
    if (typeof input.projectGroup !== "string" || input.projectGroup.length > 80) return "projectGroup must be a group name or empty";
    if (!scopes.includes("write") && !scopes.includes("logs")) return "projectGroup only applies to write and log access";
    if (!listApiProjectGroupNames().includes(input.projectGroup)) return "Unknown project group";
    projectGroup = input.projectGroup;
  }
  return { scopes, projectGroup };
}

router.get("/requests/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const request = getPendingRequest(requestId(req));
  if (!request) { res.status(404).json({ error: "This authorization request has expired. Start the connection again from your client." }); return; }
  res.json({
    clientName: request.clientName,
    redirectHost: redirectHostOf(request.redirectUri),
    redirectUri: request.redirectUri,
    // A client on this machine is the usual case. Anything else sends the approval to a web address, which the admin must recognise.
    local: isLoopbackRedirect(request.redirectUri),
    expiresAt: request.expiresAt,
    groups: listApiProjectGroupNames(),
  });
});

router.post("/requests/:id/approve", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const grant = parseGrant(req.body);
  if (typeof grant === "string") { res.status(400).json({ error: grant }); return; }
  const pending = getPendingRequest(requestId(req));
  if (!pending) { res.status(404).json({ error: "This authorization request has expired. Start the connection again from your client." }); return; }
  // Defence in depth: registration already refuses these, and nothing but https, loopback or an app link may be redirected to.
  if (redirectUriProblem(pending.redirectUri)) { res.status(400).json({ error: "This client's redirect address is not allowed" }); return; }
  const host = redirectHostOf(pending.redirectUri);
  if (!isLoopbackRedirect(pending.redirectUri) && (req.body as { confirmHost?: unknown } | undefined)?.confirmHost !== host) {
    res.status(400).json({ error: `Confirm that you recognise ${host}: the approval is sent there.` });
    return;
  }
  const request = takePendingRequest(pending.id);
  if (!request) { res.status(404).json({ error: "This authorization request has expired. Start the connection again from your client." }); return; }
  auditLog(req.user ?? "unknown", "oauth.approve", request.clientName, "ok", { clientId: request.clientId, redirectHost: host, scopes: grant.scopes, projectGroup: grant.projectGroup });
  res.json({ redirectUrl: approvePendingRequest(request, grant) });
});

router.post("/requests/:id/deny", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const request = takePendingRequest(requestId(req));
  if (!request) { res.status(404).json({ error: "This authorization request has expired." }); return; }
  auditLog(req.user ?? "unknown", "oauth.deny", request.clientName, "ok", { clientId: request.clientId });
  res.json({ redirectUrl: denyPendingRequest(request) });
});

router.get("/connections", requireAuth, (_req: Request, res: Response): void => {
  res.json(listConnectedApps());
});

router.delete("/connections/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(requestId(req));
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!disconnectApp(id)) { res.status(404).json({ error: "Connection not found or already ended" }); return; }
  auditLog(req.user ?? "unknown", "oauth.disconnect", String(id), "ok");
  res.status(204).end();
});

export default router;
