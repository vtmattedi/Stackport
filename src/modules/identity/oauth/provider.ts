import crypto from "crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getDatabase } from "../../../config/database";
import { hashApiTokenValue, issueOAuthAccessToken, parseScopes, revokeApiToken, verifyApiToken, type ApiTokenScope } from "../apiTokens";

/**
 * OAuth 2.1 authorization server for /mcp. The flow: a client registers itself, sends the admin's browser to /authorize, which parks
 * the request and redirects to the consent page (the admin signs in with the normal session and picks the scopes), then exchanges the
 * code with PKCE. The access token is an ordinary API token, so /mcp checks it exactly as it checks one made by hand.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_CLIENTS = 500;
const REFRESH_PREFIX = "sprt_";

const sha256 = hashApiTokenValue;
const random = (bytes: number): string => crypto.randomBytes(bytes).toString("base64url");
const iso = (ms: number): string => new Date(ms).toISOString();

export interface PendingRequest {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  expiresAt: string;
}

export interface Grant {
  scopes: ApiTokenScope[];
  projectGroup: string | null;
}

interface ClientRow { client_id: string; info: string }
interface RequestRow { id: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null; expires_at: string }
interface CodeRow { client_id: string; redirect_uri: string; code_challenge: string; scopes: string; project_group: string | null; expires_at: string; used_at: string | null }
interface RefreshRow { id: number; client_id: string; scopes: string; project_group: string | null; access_token_id: number | null; family: string; connected_at: string; created_at: string; expires_at: string; revoked_at: string | null; rotated_at: string | null }

function clientName(info: OAuthClientInformationFull): string {
  const name = typeof info.client_name === "string" ? info.client_name.trim() : "";
  return (name || "Unnamed client").slice(0, 60);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Schemes that run code or read local data when a browser is sent to them. A redirect to one of these from the consent page would execute in the dashboard's origin. */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "ftp:", "ws:", "wss:"]);
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;

/** Why a redirect URI is refused at registration, or null when it is fine: https, http on a loopback address (a native app), or the custom scheme of an installed app (cursor://, vscode://). */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > MAX_URI_LENGTH || !URL.canParse(uri)) return "redirect_uris must be valid URLs";
  const url = new URL(uri);
  if (url.username || url.password) return "redirect_uris must not carry credentials";
  if (url.hash) return "redirect_uris must not contain a fragment";
  if (BLOCKED_SCHEMES.has(url.protocol)) return `redirect_uris may not use the ${url.protocol} scheme`;
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname) ? null : "http redirect_uris are only allowed on localhost";
  // A custom scheme must be a hierarchical URL (name://...), which keeps javascript:-style payloads out.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? null : "redirect_uris must use https, localhost, or an app scheme such as app://callback";
}

/** A redirect on this machine (a native client) as opposed to a web address the approval would be sent to. */
export function isLoopbackRedirect(uri: string): boolean {
  return URL.canParse(uri) && new URL(uri).protocol === "http:" && LOOPBACK_HOSTS.has(new URL(uri).hostname);
}

/** Housekeeping on every new grant: expired one-time rows, and tokens that ended a week ago, with their access tokens. */
function pruneExpired(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const weekAgo = iso(Date.now() - 7 * 86_400_000);
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_requests WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM api_tokens WHERE oauth_client_id IS NOT NULL AND (expires_at < ? OR revoked_at < ?)").run(weekAgo, weekAgo);
  // A rotated token is still needed to detect replay until its original expiry.
  db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at < ? OR (rotated_at IS NULL AND revoked_at < ?)").run(weekAgo, weekAgo);
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId) {
    const row = getDatabase().prepare("SELECT client_id, info FROM oauth_clients WHERE client_id = ?").get(clientId) as ClientRow | undefined;
    return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
  },
  registerClient(client) {
    if (client.redirect_uris.length === 0 || client.redirect_uris.length > MAX_REDIRECT_URIS) throw new InvalidClientMetadataError(`redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URLs`);
    for (const uri of client.redirect_uris) {
      const problem = redirectUriProblem(String(uri));
      if (problem) throw new InvalidClientMetadataError(problem);
    }
    const db = getDatabase();
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get() as { count: number };
    if (count >= MAX_CLIENTS) {
      pruneExpired();
      // Registration is open (a client has no account yet), so a registration that holds no live grant and has nothing in flight is pruned once it is an hour old.
      db.prepare(`DELETE FROM oauth_clients WHERE created_at < ?
        AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens WHERE revoked_at IS NULL AND expires_at > ?)
        AND client_id NOT IN (SELECT client_id FROM oauth_requests)
        AND client_id NOT IN (SELECT client_id FROM oauth_codes WHERE used_at IS NULL)`).run(iso(Date.now() - 3_600_000), iso(Date.now()));
      const after = (db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get() as { count: number }).count;
      if (after >= MAX_CLIENTS) throw new InvalidRequestError("Too many registered clients; try again later");
    }
    const full: OAuthClientInformationFull = { ...client, client_id: `spc_${random(18)}`, client_id_issued_at: Math.floor(Date.now() / 1000) };
    db.prepare("INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)").run(full.client_id, JSON.stringify(full), new Date().toISOString());
    return full;
  },
};

/** `continuing` carries a rotated refresh token's family and original connect time, so reuse of an old token can end the whole family and the app keeps its first connect date. */
function issueTokens(client: OAuthClientInformationFull, grant: Grant, continuing?: { family: string; connectedAt: string }): OAuthTokens {
  const db = getDatabase();
  pruneExpired();
  const now = Date.now();
  const access = issueOAuthAccessToken({ clientId: client.client_id, clientName: clientName(client), scopes: grant.scopes, projectGroup: grant.projectGroup, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS });
  const refresh = REFRESH_PREFIX + random(32);
  db.prepare(
    "INSERT INTO oauth_refresh_tokens (token_hash, client_id, scopes, project_group, access_token_id, family, connected_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(sha256(refresh), client.client_id, grant.scopes.join(","), grant.projectGroup, access.record.id, continuing?.family ?? random(16), continuing?.connectedAt ?? iso(now), iso(now), iso(now + REFRESH_TOKEN_TTL_MS));
  return { access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: grant.scopes.join(" ") };
}

/** Parks an /authorize request until the admin answers on the consent page. */
export function createPendingRequest(client: OAuthClientInformationFull, params: AuthorizationParams): string {
  const db = getDatabase();
  pruneExpired();
  const id = random(24);
  db.prepare("INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, client.client_id, params.redirectUri, params.codeChallenge, params.state ?? null, params.resource?.href ?? null, new Date().toISOString(), iso(Date.now() + REQUEST_TTL_MS));
  return id;
}

export function getPendingRequest(id: string): PendingRequest | null {
  const row = getDatabase().prepare("SELECT * FROM oauth_requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  const client = clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined;
  if (!client) return null;
  return { id: row.id, clientId: row.client_id, clientName: clientName(client), redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, state: row.state, expiresAt: row.expires_at };
}

/** A request can be answered once: whichever of approve or deny comes first removes it. */
export function takePendingRequest(id: string): PendingRequest | null {
  const request = getPendingRequest(id);
  if (!request) return null;
  const removed = getDatabase().prepare("DELETE FROM oauth_requests WHERE id = ?").run(id);
  return removed.changes > 0 ? request : null;
}

/** The URL the admin's browser is sent back to, carrying the one-time code. */
export function approvePendingRequest(request: PendingRequest, grant: Grant): string {
  const code = random(32);
  getDatabase().prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, project_group, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sha256(code), request.clientId, request.redirectUri, request.codeChallenge, grant.scopes.join(","), grant.projectGroup, iso(Date.now() + CODE_TTL_MS));
  const url = new URL(request.redirectUri);
  url.searchParams.set("code", code);
  if (request.state) url.searchParams.set("state", request.state);
  return url.href;
}

export function denyPendingRequest(request: PendingRequest): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", "access_denied");
  if (request.state) url.searchParams.set("state", request.state);
  return url.href;
}

export interface ConnectedApp { id: number; clientName: string; scopes: ApiTokenScope[]; projectGroup: string | null; connectedAt: string; expiresAt: string }

/** One entry per live refresh token: an app the admin has approved and that can still renew its access. */
export function listConnectedApps(): ConnectedApp[] {
  const rows = getDatabase().prepare("SELECT * FROM oauth_refresh_tokens WHERE revoked_at IS NULL AND expires_at > ? ORDER BY id DESC").all(new Date().toISOString()) as RefreshRow[];
  return rows.map((row) => {
    const client = clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined;
    return { id: row.id, clientName: client ? clientName(client) : "Unknown client", scopes: parseScopes(row.scopes), projectGroup: row.project_group, connectedAt: row.connected_at, expiresAt: row.expires_at };
  });
}

/** Ends a connection now: the refresh token stops working and so does the access token it last issued. */
export function disconnectApp(id: number): boolean {
  const db = getDatabase();
  return db.transaction(() => {
    const row = db.prepare("SELECT family FROM oauth_refresh_tokens WHERE id = ?").get(id) as { family: string } | undefined;
    return row ? endFamily(row.family) : false;
  }).immediate();
}

/** The connection stays the same when a refresh replaces its access token. */
export function oauthConnectionForAccessToken(accessTokenId: number): string | undefined {
  const row = getDatabase().prepare("SELECT family FROM oauth_refresh_tokens WHERE access_token_id = ?")
    .get(accessTokenId) as { family: string } | undefined;
  return row?.family;
}

/** Revokes every refresh token of one connection and the access tokens they issued. */
function endFamily(family: string): boolean {
  const db = getDatabase();
  const now = iso(Date.now());
  db.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL
    AND id IN (SELECT access_token_id FROM oauth_refresh_tokens WHERE family = ?)`).run(now, family);
  return db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").run(now, family).changes > 0;
}

export const oauthProvider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = createPendingRequest(client, params);
    res.redirect(`/oauth/consent?request=${encodeURIComponent(id)}`);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = getDatabase().prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256(authorizationCode)) as CodeRow | undefined;
    if (!row || row.client_id !== client.client_id || row.used_at || Date.parse(row.expires_at) <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    const db = getDatabase();
    const hash = sha256(authorizationCode);
    const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hash) as CodeRow | undefined;
    if (!row || row.client_id !== client.client_id || Date.parse(row.expires_at) <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    // The code is single use: only the call that flips used_at gets tokens.
    return db.transaction(() => {
      const claimed = db.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
        .run(iso(Date.now()), hash, iso(Date.now()));
      if (claimed.changes === 0) throw new InvalidGrantError("Authorization code was already used or expired");
      return issueTokens(client, { scopes: parseScopes(row.scopes), projectGroup: row.project_group });
    }).immediate();
  },

  async exchangeRefreshToken(client, refreshToken) {
    const db = getDatabase();
    const hash = sha256(refreshToken);
    const tokens = db.transaction(() => {
      const row = db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").get(hash) as RefreshRow | undefined;
      if (!row || row.client_id !== client.client_id || Date.parse(row.expires_at) <= Date.now()) throw new InvalidGrantError("Invalid or expired refresh token");
      if (row.rotated_at) {
        endFamily(row.family);
        return null;
      }
      if (row.revoked_at) throw new InvalidGrantError("Invalid or expired refresh token");
      const now = iso(Date.now());
      db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ?, rotated_at = ? WHERE id = ?").run(now, now, row.id);
      if (row.access_token_id !== null) revokeApiToken(row.access_token_id);
      return issueTokens(client, { scopes: parseScopes(row.scopes), projectGroup: row.project_group }, { family: row.family, connectedAt: row.connected_at });
    }).immediate();
    // Throw after the transaction commits the revocation of a replayed grant.
    if (!tokens) throw new InvalidGrantError("Refresh token was already used; the connection was ended");
    return tokens;
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const record = verifyApiToken(token, "read");
    if (!record || !record.oauthClientId) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: record.oauthClientId, scopes: record.scopes, expiresAt: record.expiresAt ? Math.floor(Date.parse(record.expiresAt) / 1000) : undefined };
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    const db = getDatabase();
    const refresh = db.prepare("SELECT id FROM oauth_refresh_tokens WHERE token_hash = ? AND client_id = ? AND expires_at > ?")
      .get(sha256(request.token), client.client_id, iso(Date.now())) as { id: number } | undefined;
    if (refresh) { disconnectApp(refresh.id); return; }
    const access = db.prepare("SELECT id FROM api_tokens WHERE token_hash = ? AND oauth_client_id = ?").get(hashApiTokenValue(request.token), client.client_id) as { id: number } | undefined;
    if (access) revokeApiToken(access.id);
  },
};
