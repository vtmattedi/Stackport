import { Router, Request, Response } from "express";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { getDatabase } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import { config } from "../config/env";
import { rowToWebhook, type WebhookRow } from "../entities/Webhook";
import { decryptSecret } from "../utils/crypto";

const router = Router();

const SLUG_RE = /^[a-z0-9-]+$/;

// On Windows, .bat/.cmd files can't be spawned directly — route them through cmd.exe /c
function resolveSpawn(scriptPath: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    const ext = path.extname(scriptPath).toLowerCase();
    if (ext === ".bat" || ext === ".cmd") {
      return { cmd: "cmd.exe", args: ["/c", scriptPath] };
    }
  }
  return { cmd: scriptPath, args: [] };
}

function isSafeScriptPath(scriptPath: string): boolean {
  if (path.isAbsolute(scriptPath)) return false;
  if (scriptPath.includes("..")) return false;
  const base = path.resolve(config.scriptsDir);
  const resolved = path.resolve(base, scriptPath);
  return resolved.startsWith(base + path.sep);
}

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  const rows = getDatabase()
    .prepare("SELECT * FROM webhooks ORDER BY created_at DESC")
    .all() as WebhookRow[];
  res.json(rows.map(rowToWebhook));
});

router.post("/", requireAuth, (req: Request, res: Response): void => {
  const { slug, scriptPath, description, credentialId } = req.body as {
    slug?: unknown;
    scriptPath?: unknown;
    description?: unknown;
    credentialId?: unknown;
  };

  if (
    typeof slug !== "string" ||
    !SLUG_RE.test(slug) ||
    slug.length > 64 ||
    typeof scriptPath !== "string" ||
    scriptPath.trim().length === 0 ||
    scriptPath.length > 256
  ) {
    res.status(400).json({ error: "Invalid slug or scriptPath" });
    return;
  }

  if (!isSafeScriptPath(scriptPath)) {
    res.status(400).json({ error: "Script path must be within the scripts directory" });
    return;
  }

  const desc =
    typeof description === "string" && description.trim().length > 0
      ? description.trim().slice(0, 200)
      : null;
  const credId = credentialId === null || credentialId === undefined || credentialId === ""
    ? null
    : typeof credentialId === "number" && Number.isInteger(credentialId) && credentialId > 0
      ? credentialId
      : null;
  if (credentialId !== undefined && credentialId !== null && credentialId !== "" && credId === null) {
    res.status(400).json({ error: "credentialId must be a positive integer" });
    return;
  }

  const db = getDatabase();
  if (credId !== null && !db.prepare("SELECT id FROM credentials WHERE id = ? AND type = 'webhook'").get(credId)) {
    res.status(400).json({ error: "Webhook credential not found" });
    return;
  }
  const existing = db.prepare("SELECT id FROM webhooks WHERE slug = ?").get(slug);
  if (existing) {
    res.status(409).json({ error: "A webhook with that slug already exists" });
    return;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO webhooks (slug, script_path, description, credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(slug, scriptPath.trim(), desc, credId, now, now);

  const saved = db
    .prepare("SELECT * FROM webhooks WHERE id = ?")
    .get(result.lastInsertRowid) as WebhookRow;

  auditLog(req.user ?? "unknown", "webhook.create", slug, "ok");
  res.status(201).json(rowToWebhook(saved));
});

router.patch("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE webhooks SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, now, id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  const updated = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow;
  auditLog(req.user ?? "unknown", "webhook.toggle", updated.slug, "ok", { enabled });
  res.json(rowToWebhook(updated));
});

router.post("/:id/dry-run", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const webhook = getDatabase()
    .prepare("SELECT * FROM webhooks WHERE id = ?")
    .get(id) as WebhookRow | undefined;

  if (!webhook) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  const scriptPath = path.resolve(config.scriptsDir, webhook.script_path);
  const { cmd, args } = resolveSpawn(scriptPath);

  execFile(
    cmd,
    args,
    { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, DRY_RUN: "1" } },
    (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      const ok = !error;

      auditLog(req.user ?? "unknown", "webhook.dry-run", webhook.slug, ok ? "ok" : "fail", {
        exitCode,
        script: webhook.script_path,
      });

      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(500).json({ error: "Script not found on disk", slug: webhook.slug });
        return;
      }

      res.json({
        slug: webhook.slug,
        ok,
        exitCode,
        stdout: stdout.slice(0, 4_096),
        stderr: stderr.slice(0, 1_024),
      });
    }
  );
});

router.delete("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const db = getDatabase();
  const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as
    | WebhookRow
    | undefined;
  if (!webhook) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  auditLog(req.user ?? "unknown", "webhook.delete", webhook.slug, "ok");
  res.status(204).send();
});

// GET /api/webhooks/trigger/:slug — friendly error for accidental browser navigation
router.get("/trigger/:slug", (_req: Request, res: Response): void => {
  res.status(405).json({
    error: "Webhook triggers require POST with an X-Webhook-Signature: sha256=<hmac> header",
  });
});

// POST /api/webhooks/trigger/:slug
// No JWT — authenticated via HMAC-SHA256 of the raw request body
router.post("/trigger/:slug", (req: Request<{ slug: string }>, res: Response): void => {
  const { slug } = req.params;

  // ── 1. Look up webhook ──────────────────────────────────────────────────────
  const webhook = getDatabase()
    .prepare("SELECT * FROM webhooks WHERE slug = ?")
    .get(slug) as WebhookRow | undefined;

  if (!webhook) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  if (!webhook.enabled) {
    auditLog("anonymous", "webhook.trigger", slug, "fail", { reason: "disabled" });
    res.status(403).json({ error: "Webhook is disabled" });
    return;
  }

  // ── 2. Validate authorization ──────────────────────────────────────────────
  if (webhook.credential_id) {
    const credential = getDatabase()
      .prepare("SELECT header_name, secret_enc FROM credentials WHERE id = ? AND type = 'webhook'")
      .get(webhook.credential_id) as { header_name: string | null; secret_enc: string } | undefined;
    if (!credential?.header_name) {
      auditLog("anonymous", "webhook.trigger", slug, "fail", { reason: "missing_credential" });
      res.status(401).json({ error: "Webhook credential not configured" });
      return;
    }
    const actual = req.headers[credential.header_name.toLowerCase()];
    const actualValue = Array.isArray(actual) ? actual[0] : actual;
    const expected = decryptSecret(credential.secret_enc);
    if (typeof actualValue !== "string" || actualValue !== expected) {
      auditLog("anonymous", "webhook.trigger", slug, "fail", { reason: "invalid_header_secret" });
      res.status(401).json({ error: "Invalid webhook credential" });
      return;
    }
  } else {
    const sigHeader = req.headers["x-webhook-signature"];
    if (!sigHeader || typeof sigHeader !== "string" || !sigHeader.startsWith("sha256=")) {
      res.status(401).json({ error: "Missing or malformed X-Webhook-Signature header" });
      return;
    }

    const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", config.webhookSecret).update(payload).digest("hex");

    if (
      sigHeader.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))
    ) {
      auditLog("anonymous", "webhook.trigger", slug, "fail", { reason: "invalid_signature" });
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  // ── 3. Execute script ───────────────────────────────────────────────────────
  const scriptPath = path.resolve(config.scriptsDir, webhook.script_path);
  const { cmd, args } = resolveSpawn(scriptPath);

  execFile(
    cmd,
    args,
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      const ok = !error;

      auditLog("webhook", "webhook.trigger", slug, ok ? "ok" : "fail", {
        exitCode,
        script: webhook.script_path,
      });

      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(500).json({ error: "Script not found on disk", slug });
        return;
      }

      res.json({
        slug,
        ok,
        exitCode,
        stdout: stdout.slice(0, 4_096),
        stderr: stderr.slice(0, 1_024),
      });
    }
  );
});

export default router;
