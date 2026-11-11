import crypto from "crypto";
import { getDatabase } from "../../config/database";
import { decryptSecret, encryptSecret } from "../../shared/crypto";

/** Rows of the GitHub App tables (migration 016). Secrets are encrypted with the keyring and are returned only
 *  by `getAppSecrets`, which nothing in the HTTP layer calls. */

export type InstallationStatus = "unlinked" | "linked" | "suspended" | "removed";
export type StateRequirement = "manifest" | "link";

export interface AppRecord {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  ownerLogin: string;
  ownerType: string;
  isPublic: boolean;
  htmlUrl: string;
  /** The origin the App's URLs were registered with; when the domain changes this is what is out of date. */
  registeredOrigin: string;
  modules: string[];
  createdAt: string;
}

export interface AppSecrets { privateKey: string; webhookSecret: string; clientSecret: string }

export interface InstallationRecord {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  status: InstallationStatus;
  permissions: Record<string, string>;
  linkedAt: string | null;
  repositoryCount: number;
}

export interface RepositoryRecord {
  repositoryId: number;
  installationId: number;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  archived: boolean;
}

interface AppRow {
  app_id: number; slug: string; name: string; client_id: string; owner_login: string; owner_type: string; is_public: number;
  html_url: string; registered_origin: string; modules_json: string; created_at: string;
}

export function getApp(): AppRecord | null {
  const row = getDatabase().prepare("SELECT app_id, slug, name, client_id, owner_login, owner_type, is_public, html_url, registered_origin, modules_json, created_at FROM github_app WHERE id = 1").get() as AppRow | undefined;
  if (!row) return null;
  let modules: string[] = [];
  try { modules = (JSON.parse(row.modules_json) as unknown[]).filter((m): m is string => typeof m === "string"); } catch { /* keep none */ }
  return {
    appId: row.app_id, slug: row.slug, name: row.name, clientId: row.client_id, ownerLogin: row.owner_login, ownerType: row.owner_type,
    isPublic: row.is_public === 1, htmlUrl: row.html_url, registeredOrigin: row.registered_origin, modules, createdAt: row.created_at,
  };
}

export function getAppSecrets(): AppSecrets | null {
  const row = getDatabase().prepare("SELECT private_key_enc, webhook_secret_enc, client_secret_enc FROM github_app WHERE id = 1").get() as
    { private_key_enc: string; webhook_secret_enc: string; client_secret_enc: string } | undefined;
  if (!row) return null;
  return { privateKey: decryptSecret(row.private_key_enc), webhookSecret: decryptSecret(row.webhook_secret_enc), clientSecret: decryptSecret(row.client_secret_enc) };
}

export function saveApp(app: Omit<AppRecord, "createdAt">, secrets: AppSecrets): void {
  getDatabase().prepare(
    `INSERT OR REPLACE INTO github_app (id, app_id, slug, name, client_id, owner_login, owner_type, is_public, html_url, registered_origin, modules_json, private_key_enc, webhook_secret_enc, client_secret_enc)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(app.appId, app.slug, app.name, app.clientId, app.ownerLogin, app.ownerType, app.isPublic ? 1 : 0, app.htmlUrl, app.registeredOrigin, JSON.stringify(app.modules),
    encryptSecret(secrets.privateKey), encryptSecret(secrets.webhookSecret), encryptSecret(secrets.clientSecret));
}

// ---- the `state` of a browser round trip

const STATE_TTL_MS = 10 * 60 * 1000;

/** A random single-use value tied to who started the round trip. The cookie cannot do this job: it is
 *  SameSite=Strict, so the browser does not send it on the redirect back from github.com. */
export function createState(purpose: StateRequirement, username: string, now: number = Date.now()): string {
  const db = getDatabase();
  db.prepare("DELETE FROM github_app_states WHERE expires_at < ?").run(new Date(now).toISOString());
  const state = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO github_app_states (state, purpose, username, expires_at) VALUES (?, ?, ?, ?)").run(state, purpose, username, new Date(now + STATE_TTL_MS).toISOString());
  return state;
}

/** Returns who started it, once. A second use, another purpose or an expired value gives null. */
export function consumeState(state: unknown, purpose: StateRequirement, now: number = Date.now()): string | null {
  if (typeof state !== "string" || !/^[0-9a-f]{64}$/.test(state)) return null;
  const db = getDatabase();
  const row = db.prepare("SELECT purpose, username, expires_at FROM github_app_states WHERE state = ?").get(state) as { purpose: string; username: string; expires_at: string } | undefined;
  db.prepare("DELETE FROM github_app_states WHERE state = ?").run(state);
  if (!row || row.purpose !== purpose || Date.parse(row.expires_at) < now) return null;
  return row.username;
}

// ---- installations

interface InstallationRow {
  installation_id: number; account_id: number; account_login: string; account_type: string; status: string; permissions_json: string; linked_at: string | null; repository_count: number;
}

function toInstallation(row: InstallationRow): InstallationRecord {
  let permissions: Record<string, string> = {};
  try { permissions = JSON.parse(row.permissions_json) as Record<string, string>; } catch { /* none */ }
  const status: InstallationStatus = (["unlinked", "linked", "suspended", "removed"] as const).find((s) => s === row.status) ?? "unlinked";
  return { installationId: row.installation_id, accountId: row.account_id, accountLogin: row.account_login, accountType: row.account_type, status, permissions, linkedAt: row.linked_at, repositoryCount: row.repository_count };
}

const INSTALLATION_SELECT = `SELECT i.installation_id, i.account_id, i.account_login, i.account_type, i.status, i.permissions_json, i.linked_at,
  (SELECT COUNT(*) FROM github_app_repositories r WHERE r.installation_id = i.installation_id AND r.access_status = 'granted') AS repository_count
  FROM github_app_installations i`;

export function listInstallations(): InstallationRecord[] {
  return (getDatabase().prepare(`${INSTALLATION_SELECT} ORDER BY i.account_login COLLATE NOCASE`).all() as InstallationRow[]).map(toInstallation);
}

export function getInstallation(installationId: number): InstallationRecord | null {
  const row = getDatabase().prepare(`${INSTALLATION_SELECT} WHERE i.installation_id = ?`).get(installationId) as InstallationRow | undefined;
  return row ? toInstallation(row) : null;
}

export interface InstallationUpsert { installationId: number; accountId: number; accountLogin: string; accountType: string; permissions: Record<string, string>; suspended: boolean }

/** Records an installation GitHub told us about. An installation we already linked stays linked (or becomes
 *  suspended or unsuspended); a new one is `unlinked` until its owner is proved. */
export function upsertInstallation(input: InstallationUpsert, link: boolean): void {
  const db = getDatabase();
  const existing = db.prepare("SELECT status FROM github_app_installations WHERE installation_id = ?").get(input.installationId) as { status: string } | undefined;
  const wasLinked = existing?.status === "linked" || existing?.status === "suspended";
  const linked = link || wasLinked;
  const status: InstallationStatus = input.suspended ? "suspended" : linked ? "linked" : "unlinked";
  db.prepare(
    `INSERT INTO github_app_installations (installation_id, account_id, account_login, account_type, status, permissions_json, linked_at, updated_at)
     VALUES (@id, @accountId, @login, @type, @status, @permissions, @linkedAt, CURRENT_TIMESTAMP)
     ON CONFLICT(installation_id) DO UPDATE SET account_id = @accountId, account_login = @login, account_type = @type, status = @status,
       permissions_json = @permissions, linked_at = COALESCE(github_app_installations.linked_at, @linkedAt), updated_at = CURRENT_TIMESTAMP`,
  ).run({ id: input.installationId, accountId: input.accountId, login: input.accountLogin, type: input.accountType, status, permissions: JSON.stringify(input.permissions), linkedAt: linked ? new Date().toISOString() : null });
}

export function setInstallationStatus(installationId: number, status: InstallationStatus): void {
  getDatabase().prepare("UPDATE github_app_installations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE installation_id = ?").run(status, installationId);
}

// ---- repositories

export function replaceRepositories(installationId: number, repositories: RepositoryRecord[]): void {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare("UPDATE github_app_repositories SET access_status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE installation_id = ?").run(installationId);
    const upsert = db.prepare(
      `INSERT INTO github_app_repositories (repository_id, installation_id, full_name, default_branch, is_private, archived, access_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'granted', CURRENT_TIMESTAMP)
       ON CONFLICT(repository_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, default_branch = excluded.default_branch,
         is_private = excluded.is_private, archived = excluded.archived, access_status = 'granted', updated_at = CURRENT_TIMESTAMP`,
    );
    for (const repo of repositories) upsert.run(repo.repositoryId, installationId, repo.fullName, repo.defaultBranch, repo.isPrivate ? 1 : 0, repo.archived ? 1 : 0);
  })();
}

export function listRepositories(installationId?: number): RepositoryRecord[] {
  const rows = (installationId === undefined
    ? getDatabase().prepare("SELECT * FROM github_app_repositories WHERE access_status = 'granted' ORDER BY full_name COLLATE NOCASE").all()
    : getDatabase().prepare("SELECT * FROM github_app_repositories WHERE installation_id = ? AND access_status = 'granted' ORDER BY full_name COLLATE NOCASE").all(installationId)
  ) as { repository_id: number; installation_id: number; full_name: string; default_branch: string | null; is_private: number; archived: number }[];
  return rows.map((r) => ({ repositoryId: r.repository_id, installationId: r.installation_id, fullName: r.full_name, defaultBranch: r.default_branch, isPrivate: r.is_private === 1, archived: r.archived === 1 }));
}
