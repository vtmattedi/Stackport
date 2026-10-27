import https from "https";
import crypto from "crypto";
import { getDatabase } from "../config/database";
import { encryptSecret, decryptSecret } from "../utils/crypto";
import { rowToProject, type Project, type ProjectRow } from "../entities/Project";
import { getNginxAppConfig } from "./nginx/configWriter";
import { tokenForProject } from "./githubPoller";
import { emitProjectDataUpdate } from "./realtime";

/** Deliveries kept per project for the "Recent deliveries" list. */
const MAX_DELIVERIES_PER_PROJECT = 50;

export interface HookDelivery {
  id: number;
  deliveryId: string;
  event: string;
  ref: string | null;
  sha: string | null;
  outcome: string;
  detail: string | null;
  receivedAt: string;
}

export interface WebhookDetails {
  url: string | null;
  secret: string | null;
  githubHookId: number | null;
  deliveries: HookDelivery[];
}

/**
 * The public base URL GitHub would call. Webhooks are HTTPS-only: Stackport must be
 * published through its own nginx with a domain and SSL, so GitHub can verify the
 * certificate. A raw-IP or plain-HTTP install gets a reason instead of a URL.
 */
export function webhookBaseUrl(): { url: string | null; reason: string | null } {
  const app = getNginxAppConfig();
  if (!app.enabled || !app.domain) {
    return { url: null, reason: "Stackport isn't published on a domain. Set one up in System > Nginx to use webhooks." };
  }
  if (!app.useSsl) {
    return { url: null, reason: `Stackport is served over plain HTTP at ${app.domain}. Turn on SSL in System > Nginx to use webhooks.` };
  }
  return { url: `https://${app.domain}`, reason: null };
}

function hookUrl(publicId: string): string | null {
  const { url } = webhookBaseUrl();
  return url ? `${url}/api/hooks/github/${publicId}` : null;
}

function readRow(projectId: number): ProjectRow | undefined {
  return getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
}

function emit(projectId: number): void {
  const row = readRow(projectId);
  if (row) emitProjectDataUpdate(projectId, rowToProject(row));
}

function githubRequest(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(`https://api.github.com${path}`, {
      method,
      headers: {
        "User-Agent": "stackport-webhooks/1.0",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Authorization": `Bearer ${token}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("GitHub API request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

function githubErrorMessage(status: number, body: unknown): string {
  const message = typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : "";
  if (status === 404) return "GitHub returned 404. The token needs admin rights on the repo (classic scope admin:repo_hook, or fine-grained \"Webhooks: read and write\").";
  if (status === 403) return `GitHub refused the request (403)${message ? `: ${message}` : ""}. Check the token's webhook permission.`;
  if (status === 422) return `GitHub rejected the hook (422)${message ? `: ${message}` : ""}.`;
  return `GitHub API ${status}${message ? `: ${message}` : ""}`;
}

/** Creates the hook on GitHub. Returns the hook id, or throws with a readable reason. */
async function createGithubHook(repo: string, token: string, url: string, secret: string): Promise<number> {
  const { status, body } = await githubRequest("POST", `/repos/${repo}/hooks`, token, {
    name: "web",
    active: true,
    events: ["push"],
    config: { url, content_type: "json", secret, insecure_ssl: "0" },
  });
  if (status !== 201) throw new Error(githubErrorMessage(status, body));
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "number") throw new Error("GitHub didn't return a hook id");
  return id;
}

async function deleteGithubHook(repo: string, token: string, hookId: number): Promise<void> {
  const { status, body } = await githubRequest("DELETE", `/repos/${repo}/hooks/${hookId}`, token);
  // 404: already gone on GitHub, which is the state we want.
  if (status !== 204 && status !== 404) throw new Error(githubErrorMessage(status, body));
}

export interface EnableWebhookResult {
  project: Project;
  installedOnGithub: boolean;
  /** Why automatic install didn't happen; the hook can still be added by hand. */
  installError: string | null;
}

/**
 * Switches a project to webhook deploys: mints a per-project URL id and secret (once),
 * then tries to install the hook on GitHub with the project's token. If that fails the
 * project still uses the webhook, and the page shows the URL and secret for a manual install.
 */
export async function enableWebhook(projectId: number): Promise<EnableWebhookResult> {
  const db = getDatabase();
  const row = readRow(projectId);
  if (!row) throw new Error("Project not found");
  if (!row.github_repo) throw new Error("Set a GitHub repo before using a webhook");
  const base = webhookBaseUrl();
  if (!base.url) throw new Error(base.reason ?? "Webhooks are unavailable");

  let publicId = row.hook_public_id ?? null;
  let secret = row.hook_secret_enc ? decryptSecret(row.hook_secret_enc) : null;
  if (!publicId || !secret) {
    publicId = crypto.randomBytes(16).toString("hex");
    secret = crypto.randomBytes(32).toString("hex");
    db.prepare("UPDATE projects SET hook_public_id = ?, hook_secret_enc = ?, github_hook_id = NULL, hook_status = 'waiting', hook_last_delivery_at = NULL WHERE id = ?")
      .run(publicId, encryptSecret(secret), projectId);
  }
  db.prepare("UPDATE projects SET deploy_trigger = 'webhook', updated_at = ? WHERE id = ?").run(new Date().toISOString(), projectId);

  let installError: string | null = null;
  const fresh = readRow(projectId) as ProjectRow;
  if (fresh.github_hook_id == null) {
    const token = tokenForProject(rowToProject(fresh));
    if (!token) {
      installError = "No GitHub token for this repo, so the hook couldn't be installed automatically.";
    } else {
      try {
        const hookId = await createGithubHook(fresh.github_repo as string, token, `${base.url}/api/hooks/github/${publicId}`, secret);
        db.prepare("UPDATE projects SET github_hook_id = ? WHERE id = ?").run(hookId, projectId);
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  emit(projectId);
  const project = rowToProject(readRow(projectId) as ProjectRow);
  return { project, installedOnGithub: project.webhook?.installedOnGithub ?? false, installError };
}

/**
 * Removes the hook from GitHub (best effort) and forgets the URL id and secret.
 * `repoOverride` is used when the repo just changed and the hook lives on the old one.
 */
export async function disableWebhook(projectId: number, repoOverride?: string | null): Promise<string | null> {
  const row = readRow(projectId);
  if (!row) return null;
  let warning: string | null = null;
  const repo = repoOverride ?? row.github_repo;
  if (row.github_hook_id != null && repo) {
    const token = tokenForProject(rowToProject(row));
    if (!token) {
      warning = "No GitHub token, so the hook is still on GitHub. Remove it in the repo's webhook settings.";
    } else {
      try {
        await deleteGithubHook(repo, token, row.github_hook_id);
      } catch (err) {
        warning = `Couldn't remove the hook from GitHub: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  getDatabase().prepare(
    "UPDATE projects SET hook_public_id = NULL, hook_secret_enc = NULL, github_hook_id = NULL, hook_status = NULL, hook_last_delivery_at = NULL WHERE id = ?"
  ).run(projectId);
  return warning;
}

/** Asks GitHub to send a ping to the installed hook. */
export async function pingWebhook(projectId: number): Promise<void> {
  const row = readRow(projectId);
  if (!row?.github_hook_id || !row.github_repo) throw new Error("The hook isn't installed on GitHub by Stackport. Use \"Install on GitHub\" first, or push a commit to test a manual hook.");
  const token = tokenForProject(rowToProject(row));
  if (!token) throw new Error("No GitHub token for this repo");
  const { status, body } = await githubRequest("POST", `/repos/${row.github_repo}/hooks/${row.github_hook_id}/pings`, token);
  if (status !== 204) throw new Error(githubErrorMessage(status, body));
}

/** Re-creates the hook on GitHub (for example after it was deleted there). */
export async function reinstallWebhook(projectId: number): Promise<EnableWebhookResult> {
  const row = readRow(projectId);
  if (row?.github_hook_id != null && row.github_repo) {
    const token = tokenForProject(rowToProject(row));
    if (token) await deleteGithubHook(row.github_repo, token, row.github_hook_id).catch(() => {});
  }
  getDatabase().prepare("UPDATE projects SET github_hook_id = NULL, hook_status = 'waiting' WHERE id = ?").run(projectId);
  return enableWebhook(projectId);
}

export function getWebhookDetails(projectId: number): WebhookDetails | null {
  const row = readRow(projectId);
  if (!row?.hook_public_id) return null;
  const deliveries = getDatabase().prepare(
    "SELECT * FROM hook_deliveries WHERE project_id = ? ORDER BY received_at DESC, id DESC LIMIT 10"
  ).all(projectId) as Array<{ id: number; delivery_id: string; event: string; ref: string | null; sha: string | null; outcome: string; detail: string | null; received_at: string }>;
  return {
    url: hookUrl(row.hook_public_id),
    secret: row.hook_secret_enc ? decryptSecret(row.hook_secret_enc) : null,
    githubHookId: row.github_hook_id ?? null,
    deliveries: deliveries.map((d) => ({
      id: d.id, deliveryId: d.delivery_id, event: d.event, ref: d.ref, sha: d.sha,
      outcome: d.outcome, detail: d.detail, receivedAt: d.received_at,
    })),
  };
}

export function findProjectByHookId(publicId: string): ProjectRow | undefined {
  return getDatabase().prepare("SELECT * FROM projects WHERE hook_public_id = ?").get(publicId) as ProjectRow | undefined;
}

/** Constant-time check of GitHub's X-Hub-Signature-256 header against the raw body. */
export function verifySignature(row: ProjectRow, rawBody: Buffer, header: string | undefined): boolean {
  if (!row.hook_secret_enc || !header || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", decryptSecret(row.hook_secret_enc)).update(rawBody).digest("hex");
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function hasDelivery(deliveryId: string): boolean {
  return !!getDatabase().prepare("SELECT 1 FROM hook_deliveries WHERE delivery_id = ?").get(deliveryId);
}

export function recordDelivery(projectId: number, delivery: { deliveryId: string; event: string; ref: string | null; sha: string | null; outcome: string; detail: string | null }): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO hook_deliveries (project_id, delivery_id, event, ref, sha, outcome, detail, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(projectId, delivery.deliveryId, delivery.event, delivery.ref, delivery.sha, delivery.outcome, delivery.detail, now);
  db.prepare(
    "DELETE FROM hook_deliveries WHERE project_id = ? AND id NOT IN (SELECT id FROM hook_deliveries WHERE project_id = ? ORDER BY received_at DESC, id DESC LIMIT ?)"
  ).run(projectId, projectId, MAX_DELIVERIES_PER_PROJECT);
  db.prepare("UPDATE projects SET hook_status = 'verified', hook_last_delivery_at = ? WHERE id = ?").run(now, projectId);
  emit(projectId);
}

/** After a repo change, move the hook: remove it from the old repo and install it on the new one. */
export function moveWebhookIfRepoChanged(projectId: number, oldRepo: string | null, newRepo: string | null): void {
  if ((oldRepo ?? null) === (newRepo ?? null)) return;
  const row = readRow(projectId);
  if (!row?.hook_public_id) return;
  void (async () => {
    await disableWebhook(projectId, oldRepo);
    if (newRepo && row.deploy_trigger === "webhook") {
      await enableWebhook(projectId).catch(() => {
        getDatabase().prepare("UPDATE projects SET deploy_trigger = 'poller' WHERE id = ?").run(projectId);
        emit(projectId);
      });
    }
  })().catch((err) => console.error("[webhooks] moving hook after repo change failed:", err));
}
