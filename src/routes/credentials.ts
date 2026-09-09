import { Router, Request, Response } from "express";
import { getDatabase } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import { encryptSecret } from "../utils/crypto";
import { rowToCredential, type CredentialRow } from "../entities/Credential";

const router = Router();

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;
const HEADER_RE = /^[A-Za-z0-9-]+$/;

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  const rows = getDatabase()
    .prepare("SELECT * FROM credentials ORDER BY alias ASC")
    .all() as CredentialRow[];
  res.json(rows.map(rowToCredential));
});

router.post("/", requireAuth, (req: Request, res: Response): void => {
  const { alias, type, username, headerName, secret, description } = req.body as Record<string, unknown>;

  if (
    typeof alias !== "string" ||
    !ALIAS_RE.test(alias) ||
    alias.length === 0 ||
    alias.length > 64
  ) {
    res.status(400).json({ error: "alias must be 1-64 alphanumeric/underscore/hyphen characters" });
    return;
  }

  const credentialType = type === "github" ? "github" : type === "webhook" ? "webhook" : type === "api_key" ? "api_key" : null;
  if (!credentialType) {
    res.status(400).json({ error: "type must be github, webhook, or api_key" });
    return;
  }

  const usernameVal = typeof username === "string" && username.trim() ? username.trim().slice(0, 100) : null;
  const headerVal = typeof headerName === "string" && headerName.trim() ? headerName.trim().slice(0, 100) : null;

  if (credentialType === "github" && !usernameVal) {
    res.status(400).json({ error: "username is required for GitHub credentials" });
    return;
  }

  if (credentialType === "webhook" && (!headerVal || !HEADER_RE.test(headerVal))) {
    res.status(400).json({ error: "headerName is required for webhook credentials" });
    return;
  }

  if (typeof secret !== "string" || secret.trim().length === 0) {
    res.status(400).json({ error: "secret is required" });
    return;
  }

  const desc =
    typeof description === "string" && description.trim().length > 0
      ? description.trim().slice(0, 200)
      : null;

  const db = getDatabase();
  if (db.prepare("SELECT id FROM credentials WHERE alias = ?").get(alias)) {
    res.status(409).json({ error: "A credential with that alias already exists" });
    return;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO credentials (type, alias, username, header_name, secret_enc, is_default, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(credentialType, alias, credentialType === "github" ? usernameVal : null, credentialType === "webhook" ? headerVal : null, encryptSecret(secret.trim()), 0, desc, now, now);

  const saved = db
    .prepare("SELECT * FROM credentials WHERE id = ?")
    .get(result.lastInsertRowid) as CredentialRow;

  auditLog(req.user ?? "unknown", "credential.create", alias, "ok");
  res.status(201).json(rowToCredential(saved));
});

router.post("/:id/default", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM credentials WHERE id = ? AND type = 'github'").get(id) as CredentialRow | undefined;
  if (!row) { res.status(404).json({ error: "GitHub credential not found" }); return; }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("UPDATE credentials SET is_default = 0, updated_at = ? WHERE type = 'github'").run(now);
    db.prepare("UPDATE credentials SET is_default = 1, updated_at = ? WHERE id = ?").run(now, id);
  });
  tx();

  const saved = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow;
  auditLog(req.user ?? "unknown", "credential.default", row.alias, "ok");
  res.json(rowToCredential(saved));
});

router.delete("/default", requireAuth, (req: Request, res: Response): void => {
  getDatabase().prepare("UPDATE credentials SET is_default = 0, updated_at = ? WHERE type = 'github'").run(new Date().toISOString());
  auditLog(req.user ?? "unknown", "credential.default.clear", "github", "ok");
  res.status(204).send();
});

router.delete("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | undefined;
  if (!row) { res.status(404).json({ error: "Credential not found" }); return; }

  // Detach any projects using this credential before deletion
  db.prepare("UPDATE projects SET credential_id = NULL WHERE credential_id = ?").run(id);
  db.prepare("UPDATE projects SET github_credential_id = NULL WHERE github_credential_id = ?").run(id);
  db.prepare("DELETE FROM credentials WHERE id = ?").run(id);

  auditLog(req.user ?? "unknown", "credential.delete", row.alias, "ok");
  res.status(204).send();
});

export default router;
