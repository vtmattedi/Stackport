/* eslint-disable security/detect-object-injection -- the keys are module names from a fixed union type, or Docker-style ids and names this module wrote itself. */
import { defaultGithubClient, GithubClient, GithubError } from "./client";
import { logger } from "../../shared/logger";
import { signAppJwt } from "./jwt";
import {
  consumeState, consumeStateWithMeta, createState, getApp, getAppSecrets, getInstallation, replaceRepositories, saveApp, setInstallationStatus, listInstallations, updateAppSecrets, upsertInstallation,
  type AppRecord, type InstallationRecord, type RepositoryRecord,
} from "./store";

/**
 * Registering the App from a manifest, linking installations to it, and the tokens it uses (docs/operations/github-app.md).
 * Nothing here reads a request's `Host`: every URL is built from the saved domain setting.
 */

export type ModuleName = "deployments" | "ci" | "releases";
export const ALL_MODULES: ModuleName[] = ["deployments", "ci", "releases"];

/** What each optional module asks GitHub for. Adding one later makes every installation approve again, so they are
 *  chosen when the App is registered. */
const MODULE_GRANTS: Record<ModuleName, { permissions: Record<string, string>; events: string[] }> = {
  deployments: { permissions: { deployments: "write" }, events: [] },
  ci: { permissions: { checks: "read", actions: "read", statuses: "read" }, events: ["workflow_run", "check_suite"] },
  releases: { permissions: {}, events: ["release"] },
};

export class GithubAppError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// ---- preflight

export interface PreflightDeps {
  appConfig: () => { enabled: boolean; domain: string; useSsl: boolean };
  hasCertificate: (domain: string) => Promise<boolean>;
}

export interface Preflight {
  ok: boolean;
  /** The origin every URL would be built from, or null when the domain is not set up. */
  origin: string | null;
  problems: string[];
}

/** The App's URLs have to be reachable from the internet over HTTPS with a certificate GitHub trusts, so the
 *  page stays disabled until the domain is set up that way. */
export async function preflight(deps: PreflightDeps): Promise<Preflight> {
  const app = deps.appConfig();
  const problems: string[] = [];
  if (!app.enabled || !app.domain) problems.push("Set the Stackport domain first (Settings > Domains). GitHub has to reach this server by name.");
  else {
    if (!app.useSsl) problems.push("The Stackport domain has to use HTTPS: GitHub only sends webhooks to HTTPS URLs it can verify.");
    else if (!(await deps.hasCertificate(app.domain))) problems.push(`There is no certificate for ${app.domain} yet. Issue one first; a self-signed certificate is not accepted by GitHub.`);
  }
  return { ok: problems.length === 0, origin: app.domain ? `https://${app.domain}` : null, problems };
}

// ---- manifest

export interface ManifestOptions {
  modules: ModuleName[];
  /** An organization login, or empty for the admin's own account. */
  owner: string;
  isPublic: boolean;
}

export function buildManifest(origin: string, options: ManifestOptions): Record<string, unknown> {
  const permissions: Record<string, string> = { contents: "read" };
  // `installation` and `installation_repositories` are not listed: GitHub sends them to every App whatever it subscribed to, and
  // a manifest that names them is refused ("Default events unsupported"). The webhook handler still receives and handles them.
  const events = new Set(["push"]);
  for (const name of options.modules) {
    Object.assign(permissions, MODULE_GRANTS[name].permissions);
    for (const event of MODULE_GRANTS[name].events) events.add(event);
  }
  return {
    // GitHub limits an App name to 34 characters.
    name: `Stackport ${origin.replace(/^https:\/\//, "")}`.slice(0, 34),
    url: origin,
    description: "Deploys from this Stackport instance",
    redirect_url: `${origin}/api/github-app/manifest/callback`,
    callback_urls: [`${origin}/api/github-app/oauth/callback`],
    setup_url: `${origin}/api/github-app/setup`,
    setup_on_update: true,
    request_oauth_on_install: false,
    hook_attributes: { url: `${origin}/api/hooks/github/app`, active: true },
    public: options.isPublic,
    default_permissions: permissions,
    default_events: [...events],
  };
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface ManifestStart {
  /** Where the browser form posts to. */
  registrationUrl: string;
  /** The `manifest` form field. */
  manifest: Record<string, unknown>;
  state: string;
  /** What the page shows before sending the browser away. */
  urls: { origin: string; webhook: string; redirect: string };
}

export async function startManifest(username: string, options: ManifestOptions, deps: PreflightDeps, client: GithubClient = defaultGithubClient()): Promise<ManifestStart> {
  if (getApp()) throw new GithubAppError("An App is already registered for this instance. Remove it first to register another.", 409);
  const check = await preflight(deps);
  if (!check.ok || !check.origin) throw new GithubAppError(check.problems.join(" "), 412);
  if (options.owner && !OWNER_RE.test(options.owner)) throw new GithubAppError("The organization name is not valid.");
  const modules = ALL_MODULES.filter((m) => options.modules.includes(m));
  const manifest = buildManifest(check.origin, { ...options, modules });
  const state = createState("manifest", username, Date.now(), { isPublic: options.isPublic });
  const base = options.owner ? `${client.webUrl}/organizations/${options.owner}/settings/apps/new` : `${client.webUrl}/settings/apps/new`;
  return {
    registrationUrl: `${base}?state=${state}`,
    manifest,
    state,
    urls: { origin: check.origin, webhook: (manifest["hook_attributes"] as { url: string }).url, redirect: manifest["redirect_url"] as string },
  };
}

interface ManifestConversion {
  id: number; slug: string; name: string; client_id: string; client_secret: string; webhook_secret: string; pem: string; html_url: string;
  owner: { login: string; type: string };
  permissions?: Record<string, string>; events?: string[];
}

/** GitHub redirected back with a code. The state proves this round trip was started here, once, a moment ago. */
export async function completeManifest(code: unknown, state: unknown, deps: PreflightDeps, client: GithubClient = defaultGithubClient()): Promise<AppRecord> {
  // Spent first: any attempt at the callback, valid or not, uses the state up.
  const started = consumeStateWithMeta(state, "manifest");
  if (started === null) throw new GithubAppError("This registration link has expired or was already used. Start again from Settings > GitHub.", 410);
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GithubAppError("The code from GitHub is missing or malformed.");
  if (getApp()) throw new GithubAppError("An App is already registered for this instance.", 409);
  const check = await preflight(deps);
  if (!check.origin) throw new GithubAppError("The Stackport domain is no longer set, so the App cannot be recorded.", 412);

  let converted: ManifestConversion;
  try {
    converted = (await client.request<ManifestConversion>({ method: "POST", path: `/app-manifests/${code}/conversions` })).body;
  } catch (err) {
    throw new GithubAppError(err instanceof GithubError ? `GitHub refused the registration: ${err.message}` : "GitHub could not be reached.", 502);
  }
  if (!converted?.id || !converted.pem || !converted.webhook_secret || !converted.client_secret) throw new GithubAppError("GitHub's answer was incomplete.", 502);

  const granted = new Set(Object.keys(converted.permissions ?? {}));
  const modules = ALL_MODULES.filter((m) => Object.keys(MODULE_GRANTS[m].permissions).every((p) => granted.has(p)) && MODULE_GRANTS[m].events.every((e) => (converted.events ?? []).includes(e)));
  const record: Omit<AppRecord, "createdAt"> = {
    appId: converted.id, slug: converted.slug, name: converted.name, clientId: converted.client_id, ownerLogin: converted.owner.login, ownerType: converted.owner.type,
    isPublic: started.meta["isPublic"] === true, htmlUrl: converted.html_url, registeredOrigin: check.origin, modules,
  };
  saveApp(record, { privateKey: converted.pem, webhookSecret: converted.webhook_secret, clientSecret: converted.client_secret });
  return getApp() as AppRecord;
}

// ---- rotating the App's credentials

/** A new private key (generated on GitHub, in the App's settings) is proved before it replaces the old one: a JWT
 *  signed with it must be accepted by GitHub as this App. Until then nothing is stored, so a wrong paste cannot lock
 *  Stackport out. The webhook secret cannot be proved from here: it is replaced as given, and GitHub's own setting
 *  has to match. */
export async function rotateAppCredentials(input: { privateKey?: unknown; webhookSecret?: unknown }, client: GithubClient = defaultGithubClient()): Promise<{ privateKey: boolean; webhookSecret: boolean }> {
  const { app } = requireApp();
  const update: { privateKey?: string; webhookSecret?: string } = {};
  if (input.privateKey !== undefined) {
    const pem = typeof input.privateKey === "string" ? input.privateKey.trim() : "";
    if (!/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----$/.test(pem) || pem.length > 10_000) throw new GithubAppError("That is not a PEM private key.");
    let jwt: string;
    try { jwt = signAppJwt(app.appId, pem); } catch { throw new GithubAppError("That private key could not be read."); }
    try {
      const { body } = await client.request<{ id?: number }>({ path: "/app", bearer: jwt });
      if (body?.id !== app.appId) throw new GithubAppError("GitHub accepted the key, but for a different App.", 400);
    } catch (err) {
      if (err instanceof GithubAppError) throw err;
      throw new GithubAppError(err instanceof GithubError && err.status === 401 ? "GitHub did not accept that key for this App." : "GitHub could not be reached to check the key.", err instanceof GithubError && err.status === 401 ? 400 : 502);
    }
    update.privateKey = pem;
  }
  if (input.webhookSecret !== undefined) {
    const secret = typeof input.webhookSecret === "string" ? input.webhookSecret : "";
    if (secret.length < 16 || secret.length > 200) throw new GithubAppError("The webhook secret must be 16 to 200 characters.");
    update.webhookSecret = secret;
  }
  if (!updateAppSecrets(update)) throw new GithubAppError("Nothing to rotate: give a private key, a webhook secret, or both.");
  forgetInstallationTokens();
  return { privateKey: update.privateKey !== undefined, webhookSecret: update.webhookSecret !== undefined };
}

// ---- tokens

function requireApp(): { app: AppRecord; privateKey: string; clientSecret: string; webhookSecret: string } {
  const app = getApp();
  const secrets = getAppSecrets();
  if (!app || !secrets) throw new GithubAppError("No GitHub App is registered yet.", 404);
  return { app, ...secrets };
}

/** The App's own JWT, for the calls that are about the App (installations, installation tokens). */
export function appJwt(nowMs: number = Date.now()): string {
  const { app, privateKey } = requireApp();
  return signAppJwt(app.appId, privateKey, nowMs);
}

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<number, CachedToken>();
const tokenInFlight = new Map<number, Promise<string>>();

/** Refreshed this long before it expires. */
const REFRESH_BEFORE_MS = 60_000;

/** An installation token: kept in memory only, refreshed a minute before it expires, one request at a time per
 *  installation. It is never written to the database, a log or a git remote.
 *
 *  The installation's status is checked first, every time, so a suspended or removed installation stops at once even
 *  while a token for it is still cached. */
export async function installationToken(installationId: number, client: GithubClient = defaultGithubClient(), nowMs: number = Date.now()): Promise<string> {
  const installation = getInstallation(installationId);
  if (!installation || installation.status !== "linked") {
    tokenCache.delete(installationId);
    throw new GithubAppError("This installation is not linked to Stackport, so its repositories cannot be used.", 403);
  }
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > nowMs) return cached.token;
  const pending = tokenInFlight.get(installationId);
  if (pending) return pending;

  const request = async (): Promise<string> => {
    try {
      const { body } = await client.request<{ token: string; expires_at: string }>({ method: "POST", path: `/app/installations/${installationId}/access_tokens`, bearer: appJwt(nowMs) });
      tokenCache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
      return body.token;
    } catch (err) {
      if (err instanceof GithubError) {
        // 404: the installation is gone. 401 is about the App's own key or clock, not about this installation, so it
        // changes nothing here. 403 only means suspended when GitHub says so.
        if (err.status === 404) setInstallationStatus(installationId, "removed");
        else if (err.status === 403 && /suspend/i.test(err.message)) setInstallationStatus(installationId, "suspended");
        else if (err.status === 401) throw new GithubAppError("GitHub rejected the App's credentials. Check the private key (Settings > GitHub > Rotate credentials) and this server's clock.", 502);
      }
      throw err;
    }
  };
  // Cleared whenever it settles, however it fails: a failure must not be served to the next caller.
  const fetching: Promise<string> = request().finally(() => { if (tokenInFlight.get(installationId) === fetching) tokenInFlight.delete(installationId); });
  tokenInFlight.set(installationId, fetching);
  return fetching;
}

export function forgetInstallationTokens(): void { tokenCache.clear(); tokenInFlight.clear(); }

// ---- installations

interface GithubInstallation {
  id: number; app_id: number; account: { id: number; login: string; type: string } | null; permissions?: Record<string, string>; suspended_at?: string | null;
}

const toUpsert = (i: GithubInstallation): Parameters<typeof upsertInstallation>[0] | null => i.account
  ? { installationId: i.id, accountId: i.account.id, accountLogin: i.account.login, accountType: i.account.type, permissions: i.permissions ?? {}, suspended: !!i.suspended_at }
  : null;

/** Starts proving that the admin owns an installation: GitHub's user authorization, with a state tied to this request. */
export function startLink(username: string, client: GithubClient = defaultGithubClient()): { authorizeUrl: string } {
  const { app } = requireApp();
  const state = createState("link", username);
  const redirect = encodeURIComponent(`${app.registeredOrigin}/api/github-app/oauth/callback`);
  return { authorizeUrl: `${client.webUrl}/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}&redirect_uri=${redirect}&state=${state}` };
}

/** The callback of the user authorization. The user's token is used for one call to list the installations they can
 *  access, links the ones that belong to this App, and is dropped. */
export async function completeLink(code: unknown, state: unknown, client: GithubClient = defaultGithubClient()): Promise<InstallationRecord[]> {
  const { app, clientSecret } = requireApp();
  if (consumeState(state, "link") === null) throw new GithubAppError("This link has expired or was already used. Start again from Settings > GitHub.", 410);
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new GithubAppError("The code from GitHub is missing or malformed.");

  let userToken: string;
  try {
    const { body } = await client.request<{ access_token?: string; error?: string }>({
      method: "POST", path: "/login/oauth/access_token", web: true,
      form: { client_id: app.clientId, client_secret: clientSecret, code, redirect_uri: `${app.registeredOrigin}/api/github-app/oauth/callback` },
    });
    if (!body?.access_token) throw new GithubAppError(`GitHub did not accept the code${body?.error ? ` (${body.error})` : ""}.`, 502);
    userToken = body.access_token;
  } catch (err) {
    if (err instanceof GithubAppError) throw err;
    throw new GithubAppError("GitHub could not be reached to finish linking.", 502);
  }

  const linked: InstallationRecord[] = [];
  for (let page = 1; page <= 10; page++) {
    const { body } = await client.request<{ installations: GithubInstallation[] }>({ path: `/user/installations?per_page=100&page=${page}`, bearer: userToken });
    for (const installation of body.installations) {
      // Only this App's: the user may have other Apps installed.
      const row = installation.app_id === app.appId ? toUpsert(installation) : null;
      if (!row) continue;
      upsertInstallation(row, true);
      const record = getInstallation(row.installationId);
      if (record) linked.push(record);
    }
    if (body.installations.length < 100) break;
  }
  // Read what each can use now, so the wizard and the project switch work straight away. A failure here does not undo
  // the link: the installation's Refresh button does the same later.
  for (const installation of linked) {
    try { await refreshRepositories(installation.installationId, client); }
    catch (err) { logger.warn({ err, installationId: installation.installationId }, "github-app: repositories could not be read right after linking"); }
  }
  return linked.map((i) => getInstallation(i.installationId) ?? i);
}

/** Reads the App's installations from GitHub with the App's own JWT. New ones are recorded as `unlinked`, so they
 *  are visible but no repository of theirs is usable until the owner is proved; installations that are gone are marked. */
export async function syncInstallations(client: GithubClient = defaultGithubClient()): Promise<InstallationRecord[]> {
  requireApp();
  const seen = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const { body } = await client.request<GithubInstallation[]>({ path: `/app/installations?per_page=100&page=${page}`, bearer: appJwt() });
    for (const installation of body) {
      const row = toUpsert(installation);
      if (!row) continue;
      seen.add(row.installationId);
      upsertInstallation(row, false);
    }
    if (body.length < 100) break;
  }
  for (const known of listInstallations()) if (!seen.has(known.installationId) && known.status !== "removed") setInstallationStatus(known.installationId, "removed");
  return listInstallations();
}

// ---- repositories

interface GithubRepository { id: number; full_name: string; default_branch?: string; private?: boolean; archived?: boolean }

/** Reads the repositories an installation exposes and caches them, so the wizard answers at once and still works
 *  while GitHub is slow. Repositories no longer listed are marked revoked, not deleted. */
export async function refreshRepositories(installationId: number, client: GithubClient = defaultGithubClient()): Promise<RepositoryRecord[]> {
  const token = await installationToken(installationId, client);
  const repositories: RepositoryRecord[] = [];
  for (let page = 1; page <= 50; page++) {
    const { body } = await client.request<{ repositories: GithubRepository[] }>({ path: `/installation/repositories?per_page=100&page=${page}`, bearer: token });
    for (const repo of body.repositories) repositories.push({ repositoryId: repo.id, installationId, fullName: repo.full_name, defaultBranch: repo.default_branch ?? null, isPrivate: !!repo.private, archived: !!repo.archived });
    if (body.repositories.length < 100) break;
  }
  replaceRepositories(installationId, repositories);
  return repositories;
}
