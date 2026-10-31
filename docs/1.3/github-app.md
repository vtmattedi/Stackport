# GitHub App integration plan (Stackport 1.3)

Status: **Architecture decided (Option B); implementation pending**  
Target: `1.3` development branch  
Scope: GitHub App authentication, installation/repository discovery, cloning, and push-triggered deployments.  
Last reviewed: 2026-10-31

**Decision:** Each self-hosted Stackport instance creates and owns **its own GitHub App using GitHub's App Manifest flow**. The App's webhook, registration redirect, OAuth callback and setup URL use **that instance's HTTPS domain**. There is no central Stackport GitHub service. Manual GitHub App registration is an advanced recovery/enterprise option, not the default.

This plan is based on Stackport's existing TypeScript/Express/SQLite/Docker Compose implementation. It is an implementation proposal, not a claim that a GitHub App or its database tables already exist.

## 1. Goal and boundaries

An administrator connects GitHub to Stackport once, authorizes selected repositories in one or more personal/organization accounts, and uses those repositories for new and existing Stackport projects **without creating personal access tokens (PATs) or repository webhooks manually**.

### Goals

- Create/register one GitHub App per self-hosted Stackport instance through a guided App Manifest flow (not a shared hosted App).
- Support multiple GitHub installations/accounts and selected-repository access.
- List accessible repositories and branches in the new-project wizard; choose a repository, branch, Compose file, then deploy using existing project workflows.
- Authenticate Git operations and GitHub REST calls using short-lived *installation* access tokens.
- Receive GitHub App webhook events at one endpoint **on each Stackport instance**, routing authorized pushes to existing `requestAutoDeploy` / `actionRegistry` logic.
- Handle installation removal, suspension, repository selection changes, renames, token expiration, duplicate deliveries, and missed webhooks.
- Keep existing PAT/public-repository projects and per-project webhook/poller flows functional during migration.
- Make GitHub access an explicit per-project selection; never silently switch a project from an unavailable App installation to a more privileged PAT.

### Non-goals for initial delivery

- GitHub Actions integration, creating repositories, modifying code, or posting commit/deployment statuses.
- PR preview environments, OAuth as the general Stackport login system, or a hosted shared SaaS GitHub App.
- Rewriting the Docker deployment engine, health gates, rollbacks, and queue management.
- Enabling untrusted third-party repositories before Stackport's container isolation security gates are complete.

**Product model:** Stackport is self-hosted and each instance has its own domain, GitHub App identity and secrets. A registered App can have multiple repository/account installations as permitted by GitHub App visibility and account ownership. A future multi-tenant service would require explicit per-user installation ownership and isolation.

## 2. Existing implementation to reuse

| Current file | Existing behavior | Planned change |
| --- | --- | --- |
| `src/services/projectDeploy.ts` | PAT/default credential used by `gitAuthHeader()`; clone, fetch, SHA-pinned checkout and Compose deployment | Replace credential selection with an async auth provider supporting App/PAT/anonymous; keep deployment logic |
| `src/services/githubPoller.ts` | Branch discovery, ETags, optional webhook safety polling, per-project PAT selection | Use the same auth provider for App projects; fix ETag cache scoping by installation/identity |
| `src/services/githubWebhooks.ts` | Per-project hook provisioning, HMAC verification and recent deliveries | Retain for legacy PAT projects; **do not** install repository hooks for App projects |
| `src/routes/githubHooks.ts` / `src/app.ts` | Raw webhook payload processed before global JSON parser and limiter | Add distinct App webhook endpoint before body parsing |
| `src/services/autoDeploy.ts` | `requestAutoDeploy()`, project action slot, latest-push queue | Reuse; add durable event intake/replay before dispatch |
| `src/routes/projects.ts` / `src/services/projectAdmin.ts` | Repo and branch selection and project credential mapping | Accept an App repository/installation binding and migration flow |
| `src/routes/credentials.ts` / `src/utils/crypto.ts` | Encrypted long-lived PATs in SQLite, currently keyed from JWT secret | Preserve legacy credentials; do not store App installation tokens in SQLite |
| `src/config/database.ts` / `src/migrations/index.ts` | SQLite and additive, rollback-compatible migrations | Add installation/repository/event tables and nullable project fields |
| `client/src/pages/settings/SettingsLayout.tsx` | Deploy Triggers and Credentials settings sections | Add GitHub Connections section; update project wizard and project settings |

References: `docs/1.3/security.md` covers prerequisites S14/S1/S2/S7; `docs/1.3/backlog.md` covers unrelated deferred work.

## 3. Per-instance GitHub App Manifest registration — chosen design

**Decision: Option B.** Each Stackport deployment creates an independent GitHub App with its own callback/webhook URLs. No Stackport-operated centralized OAuth or webhook relay is required, and different Stackport installations may use unrelated hostnames.

Example: `https://sp.example.com` and `https://panel.customer.example` each create distinct Apps. Each instance receives only its own App webhooks and holds only its own private key. One GitHub App can still be installed on multiple GitHub accounts, subject to its `public`/private visibility restrictions.

### 3.1 Preflight

- Stackport must have a **stable public HTTPS origin** reachable by GitHub, with a trusted certificate. Block App setup when Stackport is exposed only by HTTP or a raw IP with an untrusted certificate.
- Determine the origin from Stackport's **trusted, persisted domain configuration**; never derive App redirect/webhook URLs from untrusted Host or X-Forwarded-* request headers.
- Display the exact generated URLs and domain before sending the user to GitHub. Warn that changing the Stackport domain later requires updating the GitHub App's URLs and completing a new HTTPS health check.
- Check that no existing App registration is configured before starting. A reinstall/restore should reuse App credentials and IDs rather than registering a different App.

### 3.2 Manifest generation

An authenticated administrator clicks **Settings → GitHub connections → Create GitHub App**. Stackport generates an expiring, one-time, session-bound random `state`, builds the manifest server-side and redirects the administrator to GitHub's App registration form with a POST:

- Personal account: `https://github.com/settings/apps/new?state=<nonce>`
- Organization-owned App: `https://github.com/organizations/<org>/settings/apps/new?state=<nonce>`
- Body parameter: `manifest`, a JSON string.

Example generated manifest (with URLs substituted from this Stackport installation):

```json
{
  "name": "Stackport My Server",
  "url": "https://sp.example.com",
  "description": "GitHub deployment integration for this Stackport instance",
  "redirect_url": "https://sp.example.com/api/github-app/manifest/callback",
  "callback_urls": [
    "https://sp.example.com/api/github-app/oauth/callback"
  ],
  "setup_url": "https://sp.example.com/api/github-app/setup",
  "setup_on_update": true,
  "request_oauth_on_install": false,
  "hook_attributes": {
    "url": "https://sp.example.com/api/hooks/github/app",
    "active": true
  },
  "public": false,
  "default_permissions": {
    "contents": "read"
  },
  "default_events": [
    "push",
    "installation",
    "installation_repositories"
  ]
}
```

The name must be unique on GitHub; the administrator can edit it on GitHub's registration screen. `public: false` is suited to a single owner account. If installations on GitHub accounts **other than the App owner** are required, explain the visibility consequences and choose `public: true` deliberately. A public App is installable by other accounts but must still be granted explicit repository access.

For this first version, use `request_oauth_on_install: false` with a dedicated setup URL, then run a separate user-authorization flow to **verify** installation ownership. GitHub does not offer `setup_url` in the same way when authorization-on-install replaces it; do not design both as simultaneous post-install callbacks.

Required App repository permission: **Contents: Read** (Metadata is provided automatically). Subscribe only to `push`, `installation`, and `installation_repositories`. `Administration` or `Webhooks: Write` is not required for the App's own webhook. Add Checks/commit statuses permissions only with later features.

### 3.3 Manifest conversion callback

GitHub redirects to the manifest `redirect_url` with a temporary `code` and the original `state`.

1. Verify an authenticated Stackport admin is completing the original session-bound request and validate the one-time `state` **before** exchanging the code.
2. Server-side call: `POST https://api.github.com/app-manifests/{code}/conversions`. The temporary code must be exchanged **within one hour**.
3. Retrieve the new App identity and generated credentials (including App ID, PEM private key, webhook secret and client secret); validate the response.
4. Persist secrets atomically to host-only encrypted/restricted configuration, e.g. `/etc/stackport/github-app/`, with correct permissions and a controlled read-only mount to the Stackport service.
5. Never return the PEM, webhook secret or client secret to the browser, logs or event messages. Clear the one-time registration state; report configured App identity and a link to install it.
6. Finish setup by installing the App on selected GitHub repositories and verifying the resulting installation using the user-authorization flow described in §4.2.

If conversion/storage fails, display a recoverable error. Handle orphaned App registration explicitly rather than silently generating another App. The manifest flow has rate limits.

### 3.4 Domain, configuration and recovery

Store configuration per Stackport instance:

- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG` (non-secrets).
- `GITHUB_APP_PRIVATE_KEY_PATH` (PEM location), `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_WEBHOOK_SECRET` (secrets).
- Persisted public origin and webhook/callback URLs used at registration.

Include App configuration and secrets in **encrypted off-site Stackport core backups**, alongside the database. Host `stackport.sh install/repair/update` must preserve and mount them correctly. On recovery to a replacement VPS, restore existing App credentials and update GitHub App URLs if the public domain changes. Never create a new App automatically on restart or after restoring a backup.

**Manual App registration** remains an advanced alternative for operators who already own a GitHub App. A shared centralized GitHub service is explicitly out of scope for self-hosted Stackport.

## 4. Authentication and installation linking

### 4.1 Installation access tokens for background operations

1. Load the App private key from the host-only path and sign a short-lived App JWT.
2. Call GitHub's installation access-token API for the *verified* installation ID.
3. Use the returned token for API calls and Git-over-HTTPS cloning/fetching; it expires after approximately **one hour**.
4. Cache tokens in memory by installation (and permission/repository scope, when restricted); refresh ahead of expiration with a single-flight lock.
5. Reacquire on restart. On a GitHub 401, invalidate once, refresh and retry safely; a 403/404 may instead indicate removed access.
6. Never persist these tokens to SQLite, logs, action output, remote URLs, or project configuration.

Suggested interface:

```ts
type GithubAuthMode = "app" | "pat" | "anonymous";

interface GithubAccess {
  mode: GithubAuthMode;
  token: string | null;
  installationId: number | null;
  expiresAt: string | null;
}

async function resolveGithubAccess(project: Project): Promise<GithubAccess>;
async function getInstallationToken(installationId: number): Promise<GithubAccess>;
```

`src/services/projectDeploy.ts` currently constructs `git -c http.extraHeader=...` arguments containing the credential; this can expose it through process arguments. Replace that with a short-lived Git credential helper or process-local `GIT_CONFIG_*` environment variables, suppress credential-bearing output, and ensure stored Git remotes never contain tokens. Apply this improvement to both App and legacy PAT modes.

### 4.2 Binding an installation to the Stackport administrator

**Do not trust `installation_id` from GitHub's setup URL.** GitHub explicitly warns that an attacker can supply a spoofed ID to this endpoint.

Proposed linking protocol:

1. Once the per-instance App has been registered through §3, an authenticated Stackport administrator clicks **Install / Connect GitHub** for an eligible GitHub account.
2. Stackport creates a new expiring, one-time, session-bound `state` nonce and starts the GitHub **user authorization** flow independently of the earlier manifest registration flow.
3. On user authorization callback, validate `state` and exchange the code server-side using the App client credentials.
4. Use the GitHub *user* access token to verify the user can access/manage the claimed installation, e.g. by listing that user's accessible installations, and confirm the App identity and account.
5. Persist the verified installation/account association. Discard the user token after linking if no ongoing on-behalf-of-user features require it.
6. Mark an installation received via webhook as `unlinked` until an authenticated owner completes verification. Never bind it to a local administrator only because the webhook or setup callback mentioned its ID.

The setup URL and the OAuth authorization callback are **different** GitHub flows. Handle both explicitly; a completed install might reach Stackport before the user authorization callback, and the administrator might close the browser partway through. Provide a retryable **Finish connection** action.

For a later multi-user Stackport, make these associations user/tenant-scoped and check permissions on every repository query and project mutation.

## 5. Persistence model

Use a new additive migration, tentatively `src/migrations/006_github_app.ts` (reconfirm the next free migration number before coding).

Suggested logical schema:

```sql
CREATE TABLE github_app_installations (
  installation_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unlinked',
  linked_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_app_repositories (
  repository_id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES github_app_installations(installation_id),
  full_name TEXT NOT NULL,
  default_branch TEXT,
  access_status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_gh_app_repos_installation
  ON github_app_repositories(installation_id);

CREATE TABLE github_app_deliveries (
  delivery_id TEXT PRIMARY KEY,
  installation_id INTEGER,
  event_name TEXT NOT NULL,
  action TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);

-- Additive changes to existing projects (nullable, safe for older installs):
ALTER TABLE projects ADD COLUMN github_auth_mode TEXT;
ALTER TABLE projects ADD COLUMN github_repository_id INTEGER;
ALTER TABLE projects ADD COLUMN github_installation_id INTEGER;
```

Migration/backfill policy:

- Existing `github_repo` values and `github_credential_id` remain intact.
- If `github_auth_mode` is null, use existing PAT/default-credential/anonymous behavior. Do not rewrite all old projects to `app`.
- Only newly linked or explicitly migrated projects use `github_auth_mode = 'app'`.
- Resolve webhook pushes by immutable GitHub `repository.id` and installation ID, *not* repository name alone.
- Update `github_repo` and the cached Git remote when a repository is renamed or transferred. If it moves outside the installation's granted access, mark it disconnected instead.
- Keep migration additive and compatible with `stackport rollback`. Existing migration runner only permits safe schema evolution.

Consider limiting delivery payload retention (redaction, TTL and size cap), while persisting enough information to re-drive an accepted webhook reliably. Do not store user access tokens or the App private key in these tables.

## 6. API and UI

### API (planned)

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /api/github-app/config` | Stackport admin | Show per-instance App registration, configured/health status and callback URLs, never private keys |
| `POST /api/github-app/manifest/start` | Stackport admin | Validate HTTPS domain, create one-time state, prepare GitHub manifest registration POST |
| `GET /api/github-app/manifest/callback` | Session-bound GitHub redirect + state | Exchange manifest code within one hour; atomically save App ID and secrets |
| `POST /api/github-app/connect` | Stackport admin | Begin post-registration installation / CSRF-bound user authorization flow |
| `GET /api/github-app/oauth/callback` | GitHub redirect + one-time state | Exchange user authorization code |
| `GET /api/github-app/setup` | GitHub redirect + one-time state | Start/complete verified installation linking, never trust query ID alone |
| `GET /api/github-app/installations` | Stackport admin | List linked installations and status |
| `GET /api/github-app/repositories?installationId=...` | Stackport admin | List only repositories authorized for that installation |
| `POST /api/github-app/reconcile` | Stackport admin | Re-fetch installation/repository access from GitHub |
| `POST /api/projects/:id/github-app` | Stackport admin | Explicitly connect/migrate an existing project |
| `DELETE /api/projects/:id/github-app` | Stackport admin | Detach App binding; require explicit fallback selection |
| `POST /api/hooks/github/app` | Signed GitHub webhook only | Central, public webhook receiver |

Protect the configuration/mutation routes with existing admin authentication and audit logs. For the callback flow, use a one-time nonce, binding to the initiating session and a short expiry. A GET callback should not initiate any project deployment.

### UI (planned)

- **Settings → GitHub connections:** if no App exists, show **Create GitHub App** and HTTPS/domain preflight; then show App identity, **Install / Connect GitHub**, connected accounts, repository access changes, Reconnect, and Disconnect. Domain changes show a callback/webhook reconfiguration warning.
- **New project wizard → Source:** GitHub App (default), Legacy PAT (advanced), or Manual upload. Show installation/account → repository → branch. Reuse existing Compose validation and the one-deploy workflow.
- **Project settings:** source mode, linked account/repository, granted permissions, auto-deploy branch, last webhook event, connection health; explicit **Migrate from PAT** action.
- **Deploy triggers:** reuse existing `manual` / `webhook` / `poller` semantics. For an App project, `webhook` means App-wide subscription, not creating/deleting a per-project GitHub hook.

## 7. App-wide webhook ingestion

Implement `src/routes/githubAppHooks.ts` mounted in `src/app.ts` **before the global JSON parser** (as with existing `/api/hooks/github/:publicId`).

For each request:

1. Read the exact raw body (bounded size and timeout).
2. Verify `X-Hub-Signature-256` using the App-specific webhook secret and constant-time comparison.
3. Validate delivery ID, event name and payload shape; insert the delivery with a **unique delivery ID** into a durable SQLite intake table.
4. Acknowledge with 2xx *only after the intake transaction commits*. Duplicate deliveries are acknowledged without executing twice.
5. Process the stored event asynchronously and idempotently; retry transient errors, quarantine permanent failures, and expose failed deliveries in the UI.
6. On `push`, verify installation is linked/active, repository ID belongs to that installation, project still has App mode/access, branch matches, push isn't a deletion/zero SHA, and commit isn't already deployed. Then call existing `requestAutoDeploy` and record outcome.
7. On `installation` / `installation_repositories`, reconcile installations and selected repositories; on suspension/removal, disable *new* GitHub operations for affected projects and show a reconnect state. **Never delete running containers or project data because access was revoked.**

GitHub may redeliver events or deliver events out of order. The DB intake table must prevent duplicate side effects. The current in-memory newest-push queue in `autoDeploy.ts` remains useful during normal operation, but is not by itself a durable delivery queue. On restart, replay pending/processing deliveries and reconcile remote branch heads before deciding to deploy.

Preserve existing push safety behavior: SHA-pinned checkout, paused/manual trigger checks, per-project action lock, deployment history, and webhook safety polling. Keep the old per-project `/api/hooks/github/:publicId` route for legacy projects until migration finishes.

## 8. Reconciliation and failure behavior

| Situation | Expected behavior |
| --- | --- |
| Installation access token expired | Refresh once and retry; do not ask for a PAT |
| GitHub API temporary outage/rate limit | Backoff; keep running containers; surface degraded GitHub state |
| App installation suspended/deleted | Mark disconnected; stop new repo reads/deploys; do not remove app data |
| Repository removed from installation | Mark that repository inaccessible; other projects unaffected |
| Repository renamed | Reconcile by numeric repository ID and update Git remote/name |
| Push webhook delivered twice | Delivery ID deduplication; no second deployment |
| Missed webhook while Stackport offline | Existing poller safety check reconciles branch tip after restart |
| Pushes during an ongoing deployment | Existing action lock and newest-commit policy; persist pending intake/replay |
| Project migration from PAT | Verify App repo access *before* switching mode; retain PAT until confirmed and offer rollback |
| GitHub App key rotated | Replace host key and invalidate token cache; preserve App installation IDs |

Metrics / operator logs: last successful App API call, token-generation errors (without token material), last webhook, backlog size, failed delivery reasons, installation/repo counts and deployments triggered.

## 9. Security gates

The GitHub App authorizes access to source code; **it does not sandbox that code**. A GitHub repository can supply Docker Compose definitions that execute privileged workloads.

Before allowing repositories controlled by external/untrusted people to deploy, implement or gate behind:

- `S14`: eliminate Stackport process secrets from the environment given to managed Compose commands.
- `S1`: validate **resolved** Compose configuration against an allowlist.
- `S2` / `S12`: isolate managed volume paths and resolve symlinks safely.
- Review `S3/S4` networking/trust-proxy exposure and `S7` secrets key separation as part of hardening.

Until then, limit GitHub App deployments to trusted repositories whose contributors are authorized to control the host. **An App's read-only Contents permission does not restrict what a deployed Compose file can execute.**

Other controls: HTTPS-only callbacks; secure cookie/session and CSRF checks; no sensitive values in logs; host-only App PEM and secrets; outbound GitHub API timeouts; webhook request size limits; no arbitrary user-supplied API URLs; confirm installation/repository grant on every sensitive operation.

## 10. Delivery phases

### Phase A — App configuration and authenticated read-only integration

- [ ] Implement **per-instance App Manifest generation** and registration POST for personal/organization GitHub accounts using the persisted HTTPS origin.
- [ ] Implement state-verified manifest callback and `POST /app-manifests/{code}/conversions` (one-hour lifetime).
- [ ] Persist generated App ID, PEM, client secret and webhook secret in host-only configuration; preserve through `stackport.sh` and encrypted backups.
- [ ] Offer explicit manual-registration fallback; never create a new App implicitly after restart/restore.
- [ ] Support separate user-authorization / installation-verification flow after App creation.
- [ ] Implement App JWT creation, token cache, GitHub REST wrapper and retries.
- [ ] Add additive schema/migration and connection status endpoint.
- [ ] Implement state-bound user authorization, installation association verification and repository discovery.
- [ ] Add GitHub Connections settings page; connect/disconnect/reconcile actions.

**Acceptance:** Two separate Stackport deployments with unrelated HTTPS domains independently create GitHub Apps through manifests, receive callbacks/webhooks on their own domains, and recover their App identities after restart/restore. Admin can link authorized GitHub installations and see only the repositories granted to each App.

### Phase B — Deploy from a GitHub App

- [ ] Introduce shared async Git credential resolver in `projectDeploy.ts` and `githubPoller.ts`.
- [ ] Avoid credential-bearing Git process arguments; cover PAT and App modes.
- [ ] Add App source/account/repo picker to the existing project wizard.
- [ ] Persist repo ID, installation ID, auth mode and selected branch on project creation.
- [ ] Add explicit legacy PAT → App migration with reversibility.

**Acceptance:** A private repository can be cloned, branches discovered and deployed without a PAT. Existing PAT and manual-upload deployments remain unchanged.

### Phase C — Webhooks, resiliency and operator visibility

- [ ] Add central signed raw-body App endpoint before normal middleware.
- [ ] Persist and deduplicate delivery IDs; implement processing/retry/replay.
- [ ] Route pushes to existing auto-deploy logic; keep poller safety fallback.
- [ ] Process installation/repository permission changes, removals, suspensions and renames.
- [ ] Display connection status and last deliveries in UI; audit transitions.
- [ ] Add failure-injection and restart tests.

**Acceptance:** A push to a selected branch triggers one SHA-pinned deployment, repeats trigger none, a missed push is recovered, and permission removal blocks future access without deleting running workloads.

### Phase D — Hardening/release

- [ ] Implement security gates `S14/S1/S2` before opening to untrusted repositories.
- [ ] Test migration rollback with older Stackport versions and existing SQLite fixtures.
- [ ] Verify secrets never appear in Git config, process argument logs or webhook history.
- [ ] Document installation, key rotation, uninstall, backups and disaster-recovery re-linking.
- [ ] Validate GitHub App permission scopes and webhook event settings against GitHub's current docs at release time.

**Acceptance:** CI passes; a clean Stackport installation can connect and deploy; an upgraded install continues existing projects; a restore on another VPS can recover the App configuration and revalidate installations.

## 11. Test matrix

- Manifest registration for unique domains, state replay/CSRF, wrong origin, expired conversion code, orphaned App and failed atomic credential storage.
- App identity/config restoration across restarts and VPS migration; domain-change webhook/callback repair without creating a second App.
- App JWT signing, expiration and clock skew; installation token single-flight and 401 refresh.
- Correct scope boundaries for two installations with similarly named repositories.
- OAuth callback state missing/replayed/expired, spoofed setup `installation_id`, and unauthorized user.
- Installation created before browser callback; account switch and repository selection updates.
- Repo rename, transfer, removal, suspension, uninstall and reconnect.
- HMAC with raw payload including Unicode, missing signature, invalid signature, forged repository IDs.
- Replayed and out-of-order delivery IDs, process crash between intake and dispatch, concurrent pushes.
- Exact-commit deployment and force-push removal; no deployment after branch deletion.
- Legacy PAT, anonymous public GitHub, manual upload, and existing webhook compatibility.
- Additive schema upgrade, rollback, database restore, host secret/key backup and restore.

## 12. Questions to settle before implementation

1. **Decision settled:** per-instance GitHub App created via Manifest (Option B), with each Stackport domain used for GitHub callbacks/webhooks. Manual registration is an advanced fallback; no central service.
2. **Connection authority:** first release links installations only to the single Stackport administrator; multi-user authorization is a separate milestone.
3. **Webhook queue retention:** set bounded payload/metadata retention and maximum retry age; avoid accumulating large sensitive payloads indefinitely.
4. **UI migration policy:** new projects default to GitHub App when configured, while current PAT projects switch only explicitly.
5. **Rate limits:** define small-host concurrency limits and backoff for repository discovery and safety polling.

## 13. Official GitHub references

- [Registering a GitHub App from a Manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Create a GitHub App from a manifest (REST)](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [About the setup URL (spoofable installation IDs)](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [Authenticating as an installation (short-lived tokens)](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
