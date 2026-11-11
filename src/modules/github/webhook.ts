import crypto from "crypto";
import { getDatabase } from "../../config/database";
import { auditLog, logger } from "../../shared/logger";
import { requestAutoDeploy } from "../automation/autoDeploy";
import { getApp, getAppSecrets, getInstallation, listRepositories, setInstallationStatus, upsertInstallation } from "./store";

/**
 * The one webhook endpoint of the GitHub App (Phase C, docs/1.3.7/github-app.md §7).
 *
 * The order matters: the signature is checked against the raw bytes first; the delivery is then written to the
 * database, and only after that does the endpoint answer 2xx, so a delivery GitHub believes was received is not lost
 * to a crash. A delivery id seen before is acknowledged without being handled twice. What is stored is a reduced copy
 * (the fields handled below, never the raw body), so it is bounded and holds nothing we do not use.
 *
 * Revoked or suspended access only disables new calls. Nothing here removes a running container or project data.
 */

export type DeliveryStatus = "received" | "processed" | "ignored" | "failed";

export interface StoredPayload {
  event: string;
  action: string | null;
  installationId: number | null;
  repository: { id: number; fullName: string } | null;
  ref: string | null;
  after: string | null;
  deleted: boolean;
  commit: { message: string | null; author: string | null; at: string | null } | null;
  account: { id: number; login: string; type: string } | null;
  permissions: Record<string, string> | null;
  suspended: boolean;
  added: { id: number; fullName: string; isPrivate: boolean }[];
  removed: { id: number; fullName: string }[];
}

export interface IntakeResult { status: number; body: Record<string, unknown> }

const MAX_FIELD = 300;
const ZERO_SHA = /^0+$/;
const clip = (value: unknown): string | null => (typeof value === "string" ? value.slice(0, MAX_FIELD) : null);

/** Constant-time check of `X-Hub-Signature-256` against the raw body. */
export function verifyAppSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  // Compared as bytes: a header of the right character count can still be longer in bytes, and timingSafeEqual throws on that.
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

/** The fields the handlers use, and nothing else. */
export function reducePayload(event: string, raw: unknown): StoredPayload {
  const body = obj(raw) ?? {};
  const installation = obj(body["installation"]);
  const repository = obj(body["repository"]);
  const account = obj(installation?.["account"]);
  const head = obj(body["head_commit"]);
  const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj).filter((v): v is Json => v !== null) : []);
  const repoId = int(repository?.["id"]);
  const permissions = obj(installation?.["permissions"]);
  return {
    event,
    action: clip(body["action"]),
    installationId: int(installation?.["id"]),
    repository: repoId !== null && typeof repository?.["full_name"] === "string" ? { id: repoId, fullName: clip(repository["full_name"]) ?? "" } : null,
    ref: clip(body["ref"]),
    after: clip(body["after"]),
    deleted: body["deleted"] === true,
    commit: head ? { message: clip(head["message"])?.split("\n")[0] ?? null, author: clip(obj(head["author"])?.["name"]), at: clip(head["timestamp"]) } : null,
    account: account && int(account["id"]) !== null && typeof account["login"] === "string" ? { id: account["id"] as number, login: clip(account["login"]) ?? "", type: clip(account["type"]) ?? "User" } : null,
    permissions: permissions ? Object.fromEntries(Object.entries(permissions).filter(([, v]) => typeof v === "string").slice(0, 50).map(([k, v]) => [k.slice(0, 60), String(v).slice(0, 20)])) : null,
    suspended: typeof installation?.["suspended_at"] === "string",
    added: list(body["repositories_added"]).filter((r) => int(r["id"]) !== null && typeof r["full_name"] === "string").slice(0, 500).map((r) => ({ id: r["id"] as number, fullName: clip(r["full_name"]) ?? "", isPrivate: r["private"] === true })),
    removed: list(body["repositories_removed"]).filter((r) => int(r["id"]) !== null && typeof r["full_name"] === "string").slice(0, 500).map((r) => ({ id: r["id"] as number, fullName: clip(r["full_name"]) ?? "" })),
  };
}

// ---- intake

/** Verifies, stores, and returns what to answer. Processing happens after the answer (see `processDelivery`). */
export function receiveAppDelivery(rawBody: Buffer, headers: { signature?: string; deliveryId?: string; event?: string }): { result: IntakeResult; deliveryId: string | null } {
  const secrets = getAppSecrets();
  if (!secrets || !getApp()) return { result: { status: 404, body: { error: "No GitHub App is registered" } }, deliveryId: null };
  if (!verifyAppSignature(secrets.webhookSecret, rawBody, headers.signature)) {
    auditLog("github", "github-app.webhook", "-", "fail", { reason: "invalid_signature" });
    return { result: { status: 401, body: { error: "Invalid signature" } }, deliveryId: null };
  }
  const deliveryId = headers.deliveryId ?? "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deliveryId)) return { result: { status: 400, body: { error: "Missing or malformed X-GitHub-Delivery" } }, deliveryId: null };
  const event = (headers.event ?? "unknown").slice(0, 60);
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody.toString("utf8")); }
  catch { return { result: { status: 400, body: { error: "Expected a JSON body" } }, deliveryId: null }; }

  const stored = reducePayload(event, parsed);
  const db = getDatabase();
  // One statement: the row is there, durably, or it is not, before GitHub is told it was received.
  const inserted = db.prepare(
    "INSERT INTO github_app_deliveries (delivery_id, event, action, installation_id, payload_json, status) VALUES (?, ?, ?, ?, ?, 'received') ON CONFLICT(delivery_id) DO NOTHING",
  ).run(deliveryId, event, stored.action, stored.installationId, JSON.stringify(stored));
  if (inserted.changes === 0) return { result: { status: 200, body: { ok: true, duplicate: true } }, deliveryId: null };
  return { result: { status: 202, body: { ok: true } }, deliveryId };
}

// ---- handling

interface DeliveryRow { delivery_id: string; payload_json: string; status: string; attempts: number }

function finish(deliveryId: string, status: DeliveryStatus, detail: string | null): void {
  getDatabase().prepare("UPDATE github_app_deliveries SET status = ?, last_error = ?, processed_at = CURRENT_TIMESTAMP WHERE delivery_id = ?").run(status, detail, deliveryId);
}

interface ProjectTarget {
  id: number; name: string; paused: number; deploy_trigger: string; auto_deploy_branch: string | null; last_commit_sha: string | null;
}

/** Projects bound to this repository id through this installation. */
function projectsFor(installationId: number, repositoryId: number): ProjectTarget[] {
  return getDatabase().prepare(
    "SELECT id, name, paused, deploy_trigger, auto_deploy_branch, last_commit_sha FROM projects WHERE github_auth_mode = 'app' AND github_installation_id = ? AND github_repository_id = ?",
  ).all(installationId, repositoryId) as ProjectTarget[];
}

/** What a push does, as `[status, detail]`. */
function handlePush(payload: StoredPayload): [DeliveryStatus, string] {
  if (payload.installationId === null || !payload.repository) return ["ignored", "A push without an installation or repository"];
  const installation = getInstallation(payload.installationId);
  if (!installation || installation.status !== "linked") return ["ignored", "The installation is not linked to Stackport, so its pushes are ignored"];
  if (!listRepositories(payload.installationId).some((r) => r.repositoryId === payload.repository?.id)) return ["ignored", "The App does not have access to this repository"];
  if (payload.deleted || !payload.after || ZERO_SHA.test(payload.after)) return ["ignored", "The branch was deleted"];
  const targets = projectsFor(payload.installationId, payload.repository.id);
  if (targets.length === 0) return ["ignored", `No project deploys ${payload.repository.fullName} through the App`];

  const outcomes: string[] = [];
  for (const project of targets) {
    if (project.paused) { outcomes.push(`${project.name}: paused`); continue; }
    if (project.deploy_trigger === "manual") { outcomes.push(`${project.name}: deploys are manual`); continue; }
    if (!project.auto_deploy_branch) { outcomes.push(`${project.name}: no auto-deploy branch`); continue; }
    if (payload.ref !== `refs/heads/${project.auto_deploy_branch}`) { outcomes.push(`${project.name}: push to ${payload.ref ?? "an unknown ref"}, not ${project.auto_deploy_branch}`); continue; }
    if (payload.after === project.last_commit_sha) { outcomes.push(`${project.name}: commit already deployed`); continue; }
    const outcome = requestAutoDeploy(project.id, { sha: payload.after, commitMessage: payload.commit?.message ?? null, commitAuthor: payload.commit?.author ?? null, commitAt: payload.commit?.at ?? null }, "webhook");
    outcomes.push(`${project.name}: ${outcome === "started" ? "deploy started" : "deploy queued"}`);
    auditLog("github", "github-app.deploy", project.name, "ok", { sha: payload.after.slice(0, 7), outcome });
  }
  const deployed = outcomes.some((o) => /deploy (started|queued)/.test(o));
  return [deployed ? "processed" : "ignored", outcomes.join("; ")];
}

function handleInstallation(payload: StoredPayload): [DeliveryStatus, string] {
  if (payload.installationId === null) return ["ignored", "An installation event without an installation"];
  const id = payload.installationId;
  switch (payload.action) {
    case "created":
      if (!payload.account) return ["ignored", "No account in the event"];
      // Seen here first, so unlinked: only the owner proving it (Settings > GitHub) makes it usable.
      upsertInstallation({ installationId: id, accountId: payload.account.id, accountLogin: payload.account.login, accountType: payload.account.type, permissions: payload.permissions ?? {}, suspended: false }, false);
      return ["processed", `Installation on ${payload.account.login} recorded; it stays unlinked until it is connected`];
    case "deleted":
      if (!getInstallation(id)) return ["ignored", "An installation we did not know"];
      setInstallationStatus(id, "removed");
      return ["processed", "Installation removed. Projects keep running; deploys through it stop"];
    case "suspend":
      if (!getInstallation(id)) return ["ignored", "An installation we did not know"];
      setInstallationStatus(id, "suspended");
      return ["processed", "Installation suspended. Projects keep running; deploys through it stop"];
    case "unsuspend": {
      const known = getInstallation(id);
      if (!known) return ["ignored", "An installation we did not know"];
      // Back to what it was: only an installation that was proved stays proved.
      setInstallationStatus(id, known.linkedAt ? "linked" : "unlinked");
      return ["processed", "Installation unsuspended"];
    }
    case "new_permissions_accepted":
      if (!getInstallation(id) || !payload.account) return ["ignored", "An installation we did not know"];
      upsertInstallation({ installationId: id, accountId: payload.account.id, accountLogin: payload.account.login, accountType: payload.account.type, permissions: payload.permissions ?? {}, suspended: payload.suspended }, false);
      return ["processed", "New permissions recorded"];
    default:
      return ["ignored", `Installation action "${payload.action ?? "unknown"}" is not used`];
  }
}

function handleRepositories(payload: StoredPayload): [DeliveryStatus, string] {
  if (payload.installationId === null) return ["ignored", "An event without an installation"];
  const installation = getInstallation(payload.installationId);
  if (!installation || installation.status === "removed") return ["ignored", "An installation we do not track"];
  const db = getDatabase();
  db.transaction(() => {
    for (const repo of payload.removed) db.prepare("UPDATE github_app_repositories SET access_status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND installation_id = ?").run(repo.id, payload.installationId);
    // Only a linked installation's repositories become usable; an unlinked one is recorded when it is linked and refreshed.
    if (installation.status !== "linked") return;
    for (const repo of payload.added) {
      db.prepare(
        `INSERT INTO github_app_repositories (repository_id, installation_id, full_name, is_private, access_status, updated_at) VALUES (?, ?, ?, ?, 'granted', CURRENT_TIMESTAMP)
         ON CONFLICT(repository_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, is_private = excluded.is_private, access_status = 'granted', updated_at = CURRENT_TIMESTAMP`,
      ).run(repo.id, payload.installationId, repo.fullName, repo.isPrivate ? 1 : 0);
    }
  })();
  return ["processed", `${payload.added.length} added, ${payload.removed.length} removed. Running projects are not touched`];
}

export function handlePayload(payload: StoredPayload): [DeliveryStatus, string] {
  switch (payload.event) {
    case "ping": return ["processed", "Webhook verified"];
    case "push": return handlePush(payload);
    case "installation": return handleInstallation(payload);
    case "installation_repositories": return handleRepositories(payload);
    default: return ["ignored", `The "${payload.event}" event is not used yet`];
  }
}

const MAX_ATTEMPTS = 3;

/** Handles a stored delivery. A failure is recorded and retried (at start-up, or by hand) up to three times. */
export function processDelivery(deliveryId: string): DeliveryStatus | null {
  const db = getDatabase();
  const row = db.prepare("SELECT delivery_id, payload_json, status, attempts FROM github_app_deliveries WHERE delivery_id = ?").get(deliveryId) as DeliveryRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE github_app_deliveries SET attempts = attempts + 1 WHERE delivery_id = ?").run(deliveryId);
  try {
    const [status, detail] = handlePayload(JSON.parse(row.payload_json) as StoredPayload);
    finish(deliveryId, status, detail);
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "failed";
    finish(deliveryId, "failed", message);
    logger.warn({ err, deliveryId }, "github-app: a delivery could not be handled");
    return "failed";
  }
}

/** A crash between intake and handling leaves rows `received`; a failure leaves `failed`. Both are tried again. */
export function resumeDeliveries(): number {
  const rows = getDatabase().prepare("SELECT delivery_id FROM github_app_deliveries WHERE status = 'received' OR (status = 'failed' AND attempts < ?) ORDER BY received_at").all(MAX_ATTEMPTS) as { delivery_id: string }[];
  for (const row of rows) processDelivery(row.delivery_id);
  return rows.length;
}

/** Replays a stored delivery by hand. It is handled again from the stored copy; the signature was checked at intake. */
export function replayDelivery(deliveryId: string): DeliveryStatus | null {
  return processDelivery(deliveryId);
}

export interface DeliveryView { deliveryId: string; event: string; action: string | null; installationId: number | null; status: DeliveryStatus; attempts: number; receivedAt: string; processedAt: string | null; detail: string | null }

export function listDeliveries(limit = 50): DeliveryView[] {
  return (getDatabase().prepare("SELECT delivery_id, event, action, installation_id, status, attempts, received_at, processed_at, last_error FROM github_app_deliveries ORDER BY received_at DESC, rowid DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 200)) as
    { delivery_id: string; event: string; action: string | null; installation_id: number | null; status: string; attempts: number; received_at: string; processed_at: string | null; last_error: string | null }[])
    .map((r) => ({ deliveryId: r.delivery_id, event: r.event, action: r.action, installationId: r.installation_id, status: (["received", "processed", "ignored", "failed"] as const).find((s) => s === r.status) ?? "received", attempts: r.attempts, receivedAt: r.received_at, processedAt: r.processed_at, detail: r.last_error }));
}

/** 14 days for handled deliveries, 30 for failed ones. */
export function pruneDeliveries(nowMs: number = Date.now()): number {
  const day = 24 * 60 * 60 * 1000;
  const db = getDatabase();
  const handled = db.prepare("DELETE FROM github_app_deliveries WHERE status IN ('processed', 'ignored') AND received_at < ?").run(new Date(nowMs - 14 * day).toISOString().replace("T", " ").slice(0, 19));
  const failed = db.prepare("DELETE FROM github_app_deliveries WHERE status = 'failed' AND received_at < ?").run(new Date(nowMs - 30 * day).toISOString().replace("T", " ").slice(0, 19));
  return handled.changes + failed.changes;
}
