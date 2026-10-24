import express, { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { auditLog } from "../utils/logger";
import { findProjectByHookId, hasDelivery, recordDelivery, verifySignature } from "../services/githubWebhooks";
import { requestAutoDeploy } from "../services/autoDeploy";

const router = Router();

// GitHub sends from a shared pool of IPs, so the app-wide per-IP limiter could drop
// real deliveries. This route gets its own, looser bucket instead.
const hookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many webhook deliveries" },
});

interface PushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  head_commit?: { message?: string; timestamp?: string; author?: { name?: string } } | null;
}

const ZERO_SHA = /^0+$/;

// POST /api/hooks/github/:publicId — no login; authenticated by the per-project HMAC secret.
// Mounted before the global JSON parser: push payloads are far larger than its 10 KB
// limit, and the signature has to be checked against the exact raw bytes.
router.post(
  "/github/:publicId",
  hookLimiter,
  express.raw({ type: "*/*", limit: "5mb" }),
  (req: Request<{ publicId: string }>, res: Response): void => {
    const row = findProjectByHookId(req.params.publicId);
    if (!row) { res.status(404).json({ error: "Unknown webhook" }); return; }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.header("x-hub-signature-256") ?? undefined;
    if (!verifySignature(row, rawBody, signature)) {
      auditLog("github", "webhook.deploy", row.name, "fail", { reason: "invalid_signature" });
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const deliveryId = req.header("x-github-delivery") ?? "";
    const event = req.header("x-github-event") ?? "unknown";
    if (!deliveryId) { res.status(400).json({ error: "Missing X-GitHub-Delivery" }); return; }
    if (hasDelivery(deliveryId)) { res.status(200).json({ ok: true, duplicate: true }); return; }

    const record = (outcome: string, detail: string | null, ref: string | null = null, sha: string | null = null) =>
      recordDelivery(row.id, { deliveryId, event, ref, sha, outcome, detail });

    if (event === "ping") {
      record("ping", "Hook verified");
      res.status(200).json({ ok: true });
      return;
    }
    if (event !== "push") {
      record("ignored", `Event "${event}" isn't used for deploys`);
      res.status(202).json({ ok: true, ignored: true });
      return;
    }

    let payload: PushPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as PushPayload;
    } catch {
      record("rejected", "Body isn't JSON. Set the hook's content type to application/json.");
      res.status(400).json({ error: "Expected a JSON body" });
      return;
    }

    const ref = payload.ref ?? null;
    const sha = payload.after ?? null;
    const branch = row.auto_deploy_branch;
    const ignore = (detail: string) => {
      record("ignored", detail, ref, sha);
      res.status(202).json({ ok: true, ignored: true, reason: detail });
    };

    if (row.deploy_trigger !== "webhook") return ignore("This project doesn't use the webhook as its deploy trigger right now");
    if (row.paused) return ignore("Project is paused");
    if ((payload.repository?.full_name ?? "").toLowerCase() !== (row.github_repo ?? "").toLowerCase()) {
      return ignore(`Push came from ${payload.repository?.full_name ?? "an unknown repo"}, not ${row.github_repo ?? "the project's repo"}`);
    }
    if (!branch) return ignore("No auto-deploy branch set");
    if (ref !== `refs/heads/${branch}`) return ignore(`Push to ${ref ?? "unknown ref"}, not ${branch}`);
    if (payload.deleted || !sha || ZERO_SHA.test(sha)) return ignore("Branch was deleted");
    if (sha === row.last_commit_sha) return ignore("Commit already deployed");

    const outcome = requestAutoDeploy(row.id, {
      sha,
      commitMessage: payload.head_commit?.message?.split("\n")[0] ?? null,
      commitAuthor: payload.head_commit?.author?.name ?? null,
      commitAt: payload.head_commit?.timestamp ?? null,
    }, "webhook");
    record(outcome === "started" ? "deploying" : "queued", outcome === "started" ? "Deploy started" : "Another action is running; deploy queued", ref, sha);
    auditLog("github", "webhook.deploy", row.name, "ok", { sha: sha.slice(0, 7), outcome });
    res.status(202).json({ ok: true, outcome });
  },
);

export default router;
