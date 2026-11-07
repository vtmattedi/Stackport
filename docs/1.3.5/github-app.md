# GitHub App, second plan (Stackport 1.3.5)

Supersedes the phases and storage choices in [../1.3/github-app.md](../1.3/github-app.md). That document stays as the reference for the security analysis (§4.2 installation linking, §7 webhook ingestion, §8 failure table); this one changes **what we build, in what order, and what else the App is for**.

Decided: every Stackport instance registers **its own** GitHub App from a **manifest**, using **its own HTTPS domain**. No shared App, no relay.

## 1. What the App is for

The first idea was listing repositories when creating a project. An App can do much more for Stackport, because it is the one GitHub identity that can read code, hear about pushes and report back, with short-lived tokens and no personal access token (PAT).

| # | Benefit | What it replaces or adds | Needs |
|---|---|---|---|
| 1 | **Pick a repository and branch** in the new-project wizard | Typing `owner/name` and hoping the PAT can see it | `contents: read`, `metadata: read` (always granted) |
| 2 | **Clone, fetch and compare with a short-lived token** | The PAT in the credentials table, and the token in `git` arguments (**G1**) | same |
| 3 | **Push events deploy** | A webhook created on every repository (needs a PAT with `admin:repo_hook`), plus a poller that burns the API rate limit | event `push`, one webhook for the whole App |
| 4 | **Read the repository before cloning**: find Compose files, services and ports, the `.env.example` variable *names*, a Dockerfile | Pull first, then discover | same contents API |
| 5 | **Bulk import**: tick several repositories that have a Compose file and create the projects | One project at a time | same |
| 6 | **Report each deploy to GitHub** as a deployment with a status | Nothing: GitHub shows no sign a commit was deployed | module M1 |
| 7 | **Deploy only after CI passes** on that commit | Auto-deploy ships a commit whose tests are still running or failed | module M2 |
| 8 | **Deploy a release or tag**, name rollbacks by tag | Branch tip only | module M3 |
| 9 | **MCP tools**: list connected repositories, create a project from one (two-step, destructive-marked) | The agent needs a project id and a token you pasted | none extra |
| 10 | Pull request comments or previews | Not now: previews run code from an unreviewed branch, which waits for S11 | module M4 |

Not planned, with the reason:

- **Container registry login (ghcr.io).** GitHub documents PATs for the registry and reports say installation tokens are rejected there, so it cannot depend on the App. A1 (deploy by digest) stays separate.
- **Sign in to Stackport with GitHub.** Out of scope; the App's user authorization is used only to prove who owns an installation.
- **Anything that writes code or opens issues.**

## 2. One manifest per instance

### 2.1 Why a manifest

Registering an App by hand means copying an App id, a private key, a webhook secret and four URLs into Stackport and getting every URL right. The manifest flow does it in one redirect and gives the instance its credentials directly, so the instance's own domain is baked into the App from the start and nobody can mistype it.

GitHub's flow, as documented:

1. Stackport sends the admin's browser to GitHub with a form POST carrying the manifest and a random `state`.
2. The admin confirms (and may rename the App).
3. GitHub redirects to our `redirect_url` with a temporary `code` and our `state`.
4. Stackport calls `POST /app-manifests/{code}/conversions` within **one hour**; the answer holds the App id, the private key (`pem`), the webhook secret and the client id and secret. The call is rate limited.

Only `url` is required in the manifest; everything below is ours to choose.

### 2.2 What we put in it

```json
{
  "name": "Stackport <instance>",
  "url": "https://<instance domain>",
  "description": "Deploys from this Stackport instance",
  "redirect_url": "https://<domain>/api/github-app/manifest/callback",
  "callback_urls": ["https://<domain>/api/github-app/oauth/callback"],
  "setup_url": "https://<domain>/api/github-app/setup",
  "setup_on_update": true,
  "request_oauth_on_install": false,
  "hook_attributes": { "url": "https://<domain>/api/hooks/github/app", "active": true },
  "public": false,
  "default_permissions": { "contents": "read" },
  "default_events": ["push", "installation", "installation_repositories"]
}
```

Modules from §1 add permissions and events to the same manifest (§3).

### 2.3 Preflight (before the button works)

- The Stackport app domain is set (Settings > Domain), served over HTTPS with a **trusted** certificate, and reachable from the internet. Without a domain Stackport serves over a raw IP with a self-signed certificate; the GitHub screen stays disabled and says what is missing.
- URLs come from the saved domain setting, never from the request's `Host` or `X-Forwarded-*`.
- The page shows the exact URLs and the chosen owner before sending the browser to GitHub.
- No App registered yet. Registering again is a separate, explicit "replace" action.

### 2.4 Owner and visibility

The manifest URL decides who owns the App, and that decides where it can be installed:

| Choice | Registration URL | Installable on |
|---|---|---|
| Personal account | `github.com/settings/apps/new` | that account only (`public: false`) |
| Organization | `github.com/organizations/<org>/settings/apps/new` | that organization (`public: false`) |
| Public (`public: true`) | either | any account that opens the install link |

The wizard asks "whose repositories will you deploy?". One owner: private App under that owner. Several owners: **public**. A public App can be installed by strangers, which is harmless here because installations stay `unlinked` until the admin proves ownership (§4) and events from unlinked installations are dropped.

### 2.5 The domain changes later

A manifest cannot be edited after registration; the URLs live in the App's settings on GitHub. When the domain changes, Stackport:

- compares the App's webhook URL (from GitHub) with the saved domain on a schedule and on every settings visit;
- shows a "URLs out of date" state with the exact values to paste, and a link to the App's settings page;
- never registers a second App on its own.

### 2.6 Where the credentials live

The 1.3 plan wanted host files under `/etc/stackport/github-app/`. Since then S7 gave us an encryption keyring, so:

- the private key, webhook secret and client secret are stored **encrypted in SQLite** with the keyring (`v2:<keyId>:…`), in one `github_app` row;
- they are covered by the existing re-encryption migration (add the columns to `SECRET_COLUMNS`; the schema-guard test then fails if one is missed);
- backups and restores that already carry the database and `ENCRYPTION_KEY` carry the App identity too; no new mount or `stackport.sh` change;
- nothing is ever returned to the browser, logged or put in an action log.

A restore on a new host keeps the same App: Stackport reads the row and only needs the domain checked (§2.5).

## 3. Modules: what the App is allowed to do

Adding a permission or event later makes **every installation approve it again**; removing one applies at once. So the permissions are chosen when the App is created, and a module added later shows as "needs approval" until the owner accepts on GitHub.

| Module | Permissions | Events | Default |
|---|---|---|---|
| Core (benefits 1 to 5, 9) | `contents: read`, `metadata: read` | `push`, `installation`, `installation_repositories` | always |
| M1 Report deploys | `deployments: write` | none | **in the manifest** |
| M2 Wait for CI | `checks: read`, `actions: read`, `statuses: read` | `workflow_run`, `check_suite` | **in the manifest** |
| M3 Releases | none beyond `contents: read` | `release` | **in the manifest** |
| M4 Pull requests | `pull_requests: read` (write if it comments) | `pull_request` | off until S11 |

Stackport reads each installation's granted permissions from GitHub and the `installation` event (`new_permissions_accepted`), and disables a module's features for an installation that has not approved it.

## 4. Linking an installation (unchanged in principle)

GitHub warns that the `installation_id` on the setup URL can be spoofed, so it is never trusted by itself.

1. Admin clicks **Connect an account**; Stackport starts GitHub's user authorization with a one-time, session-bound `state`.
2. On the callback it exchanges the code with the App's client credentials, lists the installations that user can access, and confirms the one named is among them and belongs to this App.
3. The installation is stored as `linked`. An installation first seen in a webhook is `unlinked` and its events are ignored.
4. The user token is discarded.

`state` values are rows with a short expiry (the process is single, but they must survive a restart during the browser round trip).

## 5. Data (migration 015)

```
github_app                  one row: app_id, slug, client_id, owner_login, owner_type, public,
                            html_url, registered_origin, modules (json),
                            private_key_enc, webhook_secret_enc, client_secret_enc, created_at
github_app_installations    installation_id PK, account_id, account_login, account_type,
                            status (unlinked | linked | suspended | removed), permissions (json), linked_at
github_app_repositories     repository_id PK, installation_id, full_name, default_branch,
                            private, archived, access_status, updated_at
github_app_deliveries       delivery_id PK, event, action, installation_id, payload_json (capped),
                            status, attempts, received_at, processed_at, last_error
github_app_states           state PK, purpose (manifest | link), session_id, expires_at
projects (nullable adds)    github_auth_mode, github_repository_id, github_installation_id
```

Additive only (rollback-safe, enforced by `tests/migrations.test.ts`). Existing PAT projects keep `github_auth_mode = NULL`.

Repositories are cached so the wizard answers instantly and still works when GitHub is slow; **reconcile** refreshes the cache on demand and on `installation_repositories` events. Retention for deliveries: 14 days, 256 KB each, failed ones 30 days.

## 6. Order of work

Cut by what you can use, earliest first. Every phase ends with tests and a short real-GitHub check.

| Phase | You get | Real GitHub needed |
|---|---|---|
| **0 · Git credentials (G1)** | Tokens leave process arguments for `GIT_CONFIG_*` environment variables, for PATs today and App tokens later | No |
| **1 · Connect** | Preflight, manifest registration, encrypted credentials, App JWT and installation tokens, installation linking, repository cache, Settings > GitHub, domain-drift warning | Creating the App |
| **2 · Deploy from the App** | Wizard with account, repository, branch, Compose file and `.env.example` names read through the API; clone with an installation token; project binding; PAT to App migration (reversible); MCP read tools and a two-step create-from-repository tool | The first clone |
| **3 · React** | Signed webhook endpoint, delivery table with dedupe and replay, push deploys through the existing auto-deploy path, installation and repository events (suspend, remove, rename) that never touch running containers, delivery log in the UI | Real deliveries |
| **4 · Report and gate** | M1 deployment statuses on GitHub, M2 deploy only after CI, M3 release deploys, push notification when CI fails on a deployed branch | Per module |
| **5 · Bulk import and hardening** | Import several repositories at once; key rotation; uninstall and restore documentation; rollback and upgrade fixtures; proof no secret reaches git config, argv, logs or delivery history | Partly |

### How it is tested without GitHub

A small in-process fake of the GitHub API (manifest conversion, `/app/installations`, installation tokens, repositories, contents, compare, deployments, check runs) plus a webhook sender that signs payloads. The base URL is an operator setting read from the environment only (`GITHUB_API_URL`, default `https://api.github.com`), never from the UI or the database, so a user cannot point Stackport at a server of their choosing. The same switch makes GitHub Enterprise Server possible later.

Covered with it: the manifest round trip and state replay, an expired code, JWT signing and clock skew, token refresh and single-flight, two installations with same-named repositories, spoofed `installation_id`, signature failures, duplicate and out-of-order deliveries, a crash between intake and dispatch, a force-push, a deleted branch, suspension and removal.

## 7. Safety rules that apply to everything above

- Webhook route is mounted before the JSON parser, reads a bounded raw body, checks `X-Hub-Signature-256` in constant time, writes the delivery row, answers 2xx only after the commit.
- A push deploys only if the installation is `linked`, the repository id belongs to it, the project still uses the App, the branch matches, it is not a deletion, and the commit is not already running.
- Revoked or suspended access disables new GitHub calls; **running containers and project data are never removed because access changed**.
- Installation tokens live in memory only, are refreshed one minute before expiry, and are never written to a remote URL, the database, a log or an action log.
- All GitHub calls have timeouts and a small concurrency limit (2 at a time per instance) with backoff on 403 and 429.
- The App does not sandbox what a repository deploys. S1, S2, S12 and S14 are done; S11 is not, so the connect screen says that anyone who can push to a connected repository controls what runs on this host.

## 8. Decisions

Settled on 2026-11-07:

1. **Modules.** M1, M2 and M3 are in the manifest from the start, so the App asks for `contents: read`, `deployments: write`, `checks: read`, `actions: read` and `statuses: read` and subscribes to `push`, `installation`, `installation_repositories`, `workflow_run`, `check_suite` and `release`. M4 (pull requests) stays out until S11. The registration screen still lists each module with a checkbox, so an instance that wants less can untick them; unticked modules cannot be added later without a re-approval on every installation.
2. **Owner.** Chosen at registration (§2.4): one owner gives a private App, several owners give a public one. It cannot be changed without registering a new App.

Still open: the defaults in [README.md](README.md) (single admin, retention, concurrency), unless you say otherwise they stand.

## Sources

- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest): fields, `state`, the one-hour code, the conversion response.
- [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration): added permissions need approval on each installation, removals are immediate.
- [Working with the container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry): registry authentication is documented for personal access tokens.
- [About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url): spoofable installation ids.
- Still to confirm against GitHub's docs when building: the endpoint that returns an installation's granted permissions and the App's current webhook URL, and the exact event/permission pairs for M1 to M3.
