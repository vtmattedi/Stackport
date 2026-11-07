# StackPort — Technical Overview

StackPort is a self-hosted DevOps control plane: a Node/Express backend + React client that deploys GitHub-repo or manually-uploaded projects via `docker compose`, fronts them with its own containerized nginx reverse proxy, issues Let's Encrypt certificates, and monitors the host — all from a single admin UI/API. (The optional Hostinger VPS fleet and firewall integration was removed in October 2026; its database tables are kept, unused, so `stackport rollback` still works.)

StackPort itself runs entirely in Docker. There is no host-installed nginx, Certbot, or Node.js runtime to manage — the only host-level footprint is Docker itself, the `stackport` management CLI, and a small amount of persistent state under `/etc/stackport` and `/var/lib/stackport`. This document describes the system as it exists today; see `docs/deprecated/` for the design docs that shaped it (kept as historical record, not current reference) and `.agents/skills/stackport/SKILL.md` for the agent skill used to prepare a repository for deployment.

---

## 1. Architecture

The backend uses [capability-owned modules](docs/backend-modules.md). Implementations
live at their canonical module paths; the former `src/services` directory has been removed.

### 1.1 System plane vs. workload plane

Everything StackPort itself needs to run — its own container, its own nginx, its own network — lives in one pinned Docker Compose project named `stackport` (`docker-compose.system.yml`). Every project an operator deploys through StackPort is a **separate** Compose project, isolated from the system plane and from each other. `src/integrations/docker/systemResources.ts` draws this line by checking a container's `com.docker.compose.project` label — "system" is exactly the containers belonging to the `stackport` project, everything else is a managed workload.

```
Host OS
│
├── Docker Engine
│
└── Docker
    │
    ├── stackport         (the app itself)
    ├── stackport-nginx   (reverse proxy)
    │
    ├── Project A
    ├── Project B
    └── ...
```

### 1.2 Networking — no host ports for managed apps

Managed projects never publish a host port. Routed services join `stackport-proxy`, the network nginx is on (the system stack declares it, so nginx keeps it when it is recreated), under the alias `sp<project id>-<service>`. Every project's compose file gets an **ephemeral, never-committed** rewrite (`src/modules/deployments/compose/networking.ts`) attaching the routed service(s) to it with that alias. Nginx reaches a project by the alias (`http://sp<id>-<service>:<containerPort>`), not by the plain service name, because two projects often have a service called `web`; it is also not `127.0.0.1:<port>`. At start-up Stackport moves the running routed services onto the network under their alias, so an existing project switches over without a redeploy, and removes the per-project `stackport-ingress-<id>` networks that 1.3.0 created (they used up Docker's address pool). Projects can reach each other's routed services over this network; isolation between projects is planned for 1.3.5. Projects that must reach each other internally share a **network group**, set on the project's Settings tab (not in the Compose file, and separate from the list grouping): the services an admin switches on are connected to `stackport-group-<group>` with `docker network connect --alias <service>.p<project id>`, re-applied after every deploy and at start-up, and other projects in the group reach them by that name. Nothing is shared by default.

`docker-compose.system.yml`'s `nginx` service publishes the public HTTP/HTTPS ports (the app port is bound only to host loopback) — `80:80` and `443:443`. A managed project's compose file that includes a `ports:` entry (any form) or `network_mode: host` is **rejected outright** by `src/modules/deployments/compose/policy.ts` at deploy time, with an actionable error pointing at `expose:` instead. This is a hard, fail-closed invariant, not a default that can be silently bypassed: StackPort decides what the host exposes publicly, not the application being deployed.

### 1.3 Domain routing model

A domain doesn't route to "a project" — it routes to a specific `(service, container_port)` pair within that project's compose file (`project_domains.service` / `project_domains.container_port`). One project can have several domains, each pointing at a different service if it needs to (e.g. a public web frontend on one domain, an admin API on another). `src/modules/ingress/nginx/configWriter.ts`'s `generateNginxConfig()` builds one nginx server block per routed domain, proxying to `http://<service>:<containerPort>` — see `docs/deprecated/stackport_yml.md` for the original design rationale.

### 1.4 Compose security policy

`composePolicy.ts` runs on every `docker compose up`/`config` invocation and rejects, with a specific actionable message per violation:

- `ports:` (short or long form) — no host port publication.
- `network_mode: host` / `pid: host` / `ipc: host`.
- Dangerous `cap_add` entries and `privileged: true`.
- Bind-mounting dangerous host paths (`/`, `/etc`, the Docker socket, etc.).

A rejected compose file blocks the deploy entirely — StackPort never silently rewrites a project's `ports:` into something "safe" the way earlier iterations of this system did (the retired `SP:AUTO`/port-hiding mechanisms). If your compose file needs a container-internal port reachable, use `expose:`, and register the public route via a domain (§1.3).

### 1.5 Generic TCP exposure

Projects can explicitly expose a declared TCP target as `public port -> service:container port` from the project page. StackPort persists that desired state and owns one `stackport-tcp-<id>` proxy container per exposure. The proxy publishes only the selected port, joins the shared ingress network, and forwards bytes to the service's alias unchanged; TLS, authentication, authorization, and protocol hardening remain the project's responsibility. This supports MQTTS and other TCP protocols without adding protocol-specific deployment modes or allowing managed Compose files to publish host ports.

TCP proxies use `alpine/socat:1.8.0.3`, are independently reconciled at StackPort startup, and carry StackPort ownership/route labels. A port collision fails only the new exposure. Deleting an exposure removes only its proxy; deleting a project removes all of that project's TCP proxies and desired-state rows.

### 1.6 Deployment revisions & rollback

Every successful `up` records a `project_deployments` row: the resolved git commit SHA, branch, compose file name, and both the *source* compose content (as pulled from git) and the *effective* compose content (after StackPort's own network-augmentation rewrite) — the exact bytes that actually ran. A failed/rejected deploy records a `failed` row with the blocking reason instead, without touching the currently-active revision. `ensureRepo` pins each deploy to an exact commit SHA (detached HEAD), not a floating branch — deploys are reproducible, not "whatever `git pull` happened to bring in."

`rollbackProject()` checks out a successful revision's exact SHA, restores its stored *effective* compose content directly (not a fresh git checkout + re-augmentation), and redeploys from that artifact. Exposed as `POST /:id/rollback` (optional body `{ "deploymentId": n }`), a "Roll back" button on the project detail page's Deployments card, and a "Restore" button on each earlier revision.

Without a `deploymentId`, the target is the newest earlier revision that differs from the running one and that no rollback has moved away from: a rollback marks the revision it replaces (`rolled_back_at`), so rolling back twice keeps going back instead of returning to the broken revision. A revision marked this way can still be restored explicitly. Revisions are ordered by id, since `created_at` has one-second resolution.

Deployment history keeps the 20 newest attempts plus the active revision and default rollback target when those fall outside the recent window. Repeated blocked or failed attempts cannot evict these recovery artifacts. Project creation and its optional initial domain commit together; a rejected initial domain leaves no partially created project.

Auto-deploys (poller and webhook) deploy the commit that triggered them, not whatever the branch tip is by the time the deploy starts. If that commit is no longer on the branch (for example after a force-push), the deploy fails with that reason; the new tip arrives as its own deploy.

### 1.7 Docker storage management

Unbounded image/build-cache growth on a long-running host is a real failure mode, so StackPort manages it actively (`src/modules/maintenance/storage/operations.ts`, `src/modules/maintenance/storage/monitor.ts`):

- A background monitor (`certbotRenewalMonitor.ts`) sweeps temporary Certbot containers daily and reloads nginx after successful renewal.
- A pre-build disk-pressure guard runs before every build — if free space is critically low, the build is blocked with a clear message rather than being allowed to run the host out of disk mid-build.
- Manual build-cache pruning is one click on the System → Docker tab.

---

## 2. Installation and host lifecycle — `stackport.sh`

See [the first-install postmortem](docs/first-install-postmortem.md) for the
bootstrap fixes, regression runner, and replacement-VPS checklist. Installation
waits for HTTPS through nginx before reporting completion.

Installation and ongoing host management go through one script, `stackport.sh`, which also installs itself as `/usr/local/bin/stackport`. Full command semantics live in `docs/deprecated/stackport_host_lifecycle.md` (the original design doc — commands below match what's actually implemented).

```bash
curl -fsSL https://raw.githubusercontent.com/vtmattedi/Stackport/main/stackport.sh -o stackport.sh
chmod +x stackport.sh
sudo ./stackport.sh install
```

`install` is fully idempotent — safe to rerun; it never regenerates secrets, never recreates the bootstrap admin on an already-initialized install, and never wipes data. It:

1. Detects the OS, ensures Docker is installed.
2. Creates `/etc/stackport` (config/secrets) and `/var/lib/stackport/{data,logs,nginx,backups,update,certbot-webroot}` (persistent state) and `/etc/letsencrypt` (persistent certificate storage — kept separate from `/var/lib/stackport` for sharing with nginx and temporary Certbot containers).
3. Writes `/etc/stackport/stackport.env` — asks **only** for a domain (optional — blank means a raw-IP install) and, if a domain was given, a Certbot/ACME email. Everything else is generated, derived, or defaulted; no hand-written `.env` is required.
4. Writes `/etc/stackport/secrets.env` — generates `JWT_SECRET`/`WEBHOOK_SECRET` (`openssl rand -hex 32`) and, on a genuinely fresh install, a one-time bootstrap credential (`openssl rand | base32`, ~80 bits, dash-formatted), **printed to the terminal exactly once**.
5. Configures `ufw` (SSH detected and allowed first, then 80/443, default-deny the rest) if `ufw` is present. Additional public TCP listeners exist only through explicit project TCP exposure records.
6. Clones/updates the StackPort source into `/var/lib/stackport/app`, regenerates a merged `.env` for the compose stack from `stackport.env` + `secrets.env` + fixed host-path variables, builds and starts the system stack, and health-checks it. If the source repo is private, the first credential-less clone attempt fails the way GitHub/most forges now always fail plain password auth over HTTPS — `install` prompts once for a GitHub personal access token and retries, then persists it to `secrets.env` (`STACKPORT_REPO_TOKEN`) so `update` never needs to ask again. A public repo never triggers this prompt at all.

Other commands:

| Command | Purpose |
|---|---|
| `stackport update` | Pulls/rebuilds/recreates StackPort itself (never managed projects). Backs up the database (`VACUUM INTO`) before touching anything — fails closed if the backup fails. Auto-rolls-back on a failed post-update health check. |
| `stackport rollback` | Reverts to the previous known-good StackPort version recorded by `update`. |
| `stackport status` | Non-mutating: version, container state, health, certificate presence/expiry, `stackport-proxy` network, firewall state, last update result. |
| `stackport repair` | Reconciles StackPort-owned infrastructure — recreates the `stackport-proxy` network and the nginx-data scaffold if missing, fixes directory ownership, restarts unhealthy containers. Never touches admin/secrets/certs/project data. |
| `stackport admin-recovery` | Root + interactive-TTY only. Generates a temporary recovery credential (`docker exec ... dist/cli/adminRecovery.js`) for resetting the administrator password — see §3.2. No HTTP endpoint can trigger this; `docker exec` on the daemon socket *is* the authorization boundary. |
| `stackport uninstall [--purge]` | Removes StackPort's own containers/network, preserving `/etc/stackport` and `/var/lib/stackport` by default so it can be reinstalled/recovered later. `--purge` also deletes that preserved state — requires typed confirmation, refuses to run non-interactively. |

The CLI and Settings share the same source-update and rollback flow. A detached Docker updater runs the installed host CLI and survives app replacement.

---

### Release promotion and update branch

Development happens on `main`, but installed servers follow `stable` by default.
On each push to `main`, [`promote.yml`](.github/workflows/promote.yml)
runs the reusable [CI workflow](.github/workflows/ci.yml) and
[upgrade scenarios](.github/workflows/upgrade.yml). The upgrade job installs
the version at the current `stable` tip on a fresh runner and tests the
transition to the candidate commit, including CLI and in-app update paths,
broken builds, broken runtimes, and rollback against a newer database.
If either validation job fails, promotion does not run. The promotion job
uses a non-forced push, so `stable` only fast-forwards.

The host CLI's `configured_branch()` defaults to `stable`. An explicit
`stackport install --branch=<name>` saves another branch for subsequent
updates; `STACKPORT_BRANCH` overrides the configured branch for one invocation.
The installer script can be downloaded from `main`, but installation still
checks out `stable` unless overridden.

Promotion is not a fleet rollout: running installations update only when
the operator invokes `stackport update` (directly or through Settings).
The updater backs up the Stackport database before switching versions,
checks the replacement's health, and rolls back to the previous recorded
version on failure. Managed projects are not updated by this operation.
Because rollback may run older code on a newer database, schema migrations
must preserve backward compatibility.

## 3. First login and administrator identity

StackPort is single-admin — there is no multi-user model. The identity lives in `app_meta` (`admin_username`/`admin_password_hash`), not in a hand-edited `.env` file.

### 3.1 Bootstrap (first install)

1. `stackport.sh` prints a one-time username/password (§2 step 4) when the install is genuinely fresh.
2. Open the app — over HTTPS even with no domain configured (see §5.3 for how). The login page detects an uninitialized install (`GET /api/setup/status`) and shows a setup form instead of the normal login form.
3. Enter the bootstrap credential. This exchanges it for a short-lived, single-purpose **setup session** (`src/routes/setup.ts`) — a separate JWT namespace from normal auth tokens, enforced server-side: a setup token can't reach any normal `/api/*` route, and a normal auth token can't reach the setup routes.
4. The setup session can only do one thing: `POST /api/setup/admin` with a chosen username + password. This writes the real admin identity, marks the install initialized, and consumes the bootstrap credential (it can never be used again).
5. Normal login now works with the chosen credentials.

### 3.2 Locked out — `stackport admin-recovery`

```bash
sudo stackport admin-recovery
```

Root + an interactive TTY are required. Generates a fresh recovery credential (invalidating any previous unconsumed one), printed once. Logging in with it grants a setup session scoped to exactly one action: `POST /api/setup/recovery`, which overwrites the admin identity the same way bootstrap does. A recovery session can't deploy projects, read secrets, or do anything else a normal session can.

### 3.3 Sessions

A successful login sets the session in an httpOnly, `SameSite=Strict` cookie that scripts on the page cannot read. A session slides forward while in use (`SESSION_IDLE_HOURS`, default 24) but ends a fixed time after login (`SESSION_MAX_HOURS`, default 12). State-changing requests authenticated by the cookie must also send `X-Requested-With: stackport`; scripts can use the token from a login that sends no such header as `Authorization: Bearer`. Tokens are additionally tracked server-side (`auth_tokens` table), making them properly revocable: logout, password change, and admin-recovery all delete the relevant rows rather than just waiting for expiry.

---

## 4. Managing StackPort itself (day to day)

Settings offers **Update Stackport**. It runs the installed `stackport update` command in a detached system Docker helper: fetch latest source, back up the database, rebuild/recreate the system stack, verify health and roll back if health checks fail. Managed projects are untouched. The helper uses host networking and a chroot into the host filesystem so the CLI sees its existing configuration, credentials and Docker socket. No installation-script changes or additional host service are required.

Authenticated `POST /api/system/update` starts the job; duplicate starts return 409. `GET /api/system/update/status` reports job ID, logs and running/success/failed/rolled-back status from Docker. The helper and its logs remain after completion until the next update. Settings resumes polling after app replacement or page reload and waits for the job result instead of assuming success from `/health`.

---

## 5. Nginx and certificates

### 5.1 Docker services

Nginx runs continuously in `stackport-nginx`, controlled through `docker exec`. Certbot runs in temporary containers using the shared ACME webroot. System reports Docker availability; there is no host installation button or runtime switch. Legacy stored `nginx_runtime=host` values are ignored.

### 5.2 Config generation, validation, and rollback

StackPort owns one generated file, `<NGINX_PATH>/sites-available/default`, rebuilt from two editable templates (`templates/general.conf`, `templates/project.conf`) plus live project/domain state on every apply. Every apply validates the candidate (`nginx -t`, run inside `stackport-nginx`) **before** touching the live file; a validation failure leaves the live config untouched and saves the bad candidate to a "Failed" document for inspection. A successful validate-and-replace backs up the previous live file first; if the post-replace test or reload fails, the backup is restored automatically. Both templates are directly editable from System → Nginx.

### 5.3 HTTPS with no domain — self-signed bootstrap

A raw-IP install (§2 step 3, blank domain) still needs HTTPS for the very first login. `src/modules/ingress/bootstrap.ts`'s `ensureAppIngress()` runs once at boot: if no app domain is configured and no domain was supplied, it generates a long-lived self-signed certificate (`src/modules/ingress/nginx/selfSignedCert.ts`, via an ephemeral `docker run` since the app's own `/etc/letsencrypt` mount is deliberately read-only) and nginx serves it as the HTTPS `default_server` — reachable at `https://<server-ip>/` with a browser trust warning, but encrypted. The moment a real app domain is configured (via System → Nginx, or `STACKPORT_DOMAIN` at install time), StackPort automatically runs the same three-stage HTTP→issue→HTTPS flow used for projects (below) and the self-signed fallback is superseded — no manual cleanup needed.

### 5.4 Per-project SSL issuance

Issuance is sequenced to avoid the chicken-and-egg problem of needing a live HTTP route before Let's Encrypt's HTTP-01 challenge can succeed:

1. SSL forced off, nginx applied (plain HTTP route live, ACME challenge location active).
2. Certificate issued.
3. SSL flag flipped on, nginx applied again with the final HTTPS block.

A background monitor (`certbotRenewalMonitor.ts`) sweeps temporary Certbot containers daily and reloads nginx after successful renewal.

---

## 6. Managing a project

### 6.1 Creating a project

Projects can belong to a named group, selected or created in the creation wizard
and changed in project settings. Existing projects remain ungrouped until assigned.
Groups appear as collapsible sections in the Projects submenu, and the projects
table can be filtered by group. Clearing a project's group does not affect deployment.

Ingress uses the shared select component to choose detected `service:port` targets
from the selected, resolved Compose configuration. TCP `expose`/container-target
ports are read, with `PORT`/`HTTP_PORT` environment values as a fallback. Host ports
are never routing targets. Add `expose` and refresh if no target is detected;
selecting another Compose file refreshes the wizard's options. The server also
checks that the chosen port is declared for its service before saving a route.

Projects → "Add new project" — GitHub repo or manually-uploaded compose file. The wizard has three stages and starts nothing until the last one:

1. **Source** creates the project and fetches its files: a clone for GitHub, or a staged and `docker compose config`-validated upload (`POST /projects/:id/upload` with `deploy=false`). A failed fetch can be retried with a corrected repo or token.
2. **Configure** collects the branch (switching it checks it out straight away), the Compose file, the deploy trigger, env files and routing. Env files are edited in the shared Environment Manager; `env_file:` paths the Compose file references but that neither exist in the source nor are managed by StackPort are flagged (`GET /projects/:id/compose-env-files`). The domain step asks for the domain and a detected Compose service/container port from the select (§1.3) — there is no internal-port field anywhere in the UI; ports are never published to the host at all. Until the first deploy writes the env files, `docker compose config` may not resolve, so service targets fall back to the literal ports in the raw YAML.
3. **Deploy** checks out the branch, saves the settings, runs Compose, adds the domain and issues SSL, in that order. A failed step is retried from where it stopped.

Closing before the deploy finishes offers to keep or discard the project. A kept project that isn't deployed and has no domain shows **Finish setup** in the projects list (also reachable as `/projects?setup=<id>`), which reopens the wizard at Configure.

### 6.2 Compose requirements

- `expose:` the container-internal port your app listens on — never `ports:`.
- No `network_mode: host`, no `privileged: true`, no dangerous bind mounts (§1.4) — a violating file is rejected at deploy time with a specific error, not silently rewritten.
- The service you register a domain against must actually exist in the compose file (validated server-side before the domain is saved).

See `.agents/skills/stackport/SKILL.md` for the full operational checklist (this is what the StackPort MCP server's `stackport://skills/project-prep` resource also serves).

### 6.3 Actions

Pull, Docker Compose (no pull), Deploy (pull+build+up, what auto-deploy triggers), Force Recreate (`--force-recreate`), Force Rebuild (`build --no-cache` + `--force-recreate`), Stop, Stop & Delete Data (destructive, confirmation-gated), Pause/Resume (pausing drops the project from nginx routing without touching containers/data), and Rollback (§1.5). All stream live output over WebSocket and record deploy history.

### 6.4 Env files, auto-deploy, health checks

Unchanged in shape from earlier versions of the system: named `.env` files per project (written to disk right before every build/deploy), an auto-deploy branch the GitHub poller watches, and a health-check endpoint/interval StackPort polls independently.

A project's health check is a path on one of its domains, fetched over HTTPS or HTTP to match the domain's SSL setting. With a path and a domain set, every deploy and rollback is verified: after `docker compose up` succeeds, Stackport polls the check every 3 seconds for the project's grace period (default 60 s, 5–600 s). If it never passes, the revision stays the running (`active`) one but is marked unhealthy (`health_failed_at`), the action reports failure, and a "deploy failed its health check" alert is sent when notifications are enabled. With **Roll back if unhealthy** turned on (off by default), a failed deploy then rolls back to the default rollback target; a rollback that fails its own check never triggers another. Without a health check path, a deploy counts as successful once its containers start, as before.

**Deploy triggers.** Each GitHub project picks one: `webhook` (GitHub calls Stackport on every push; needs Stackport published on an HTTPS domain), `poller` (Stackport asks GitHub at the poll interval), or `manual`. New projects start on the webhook when it's available. With the poller's webhook safety check on (the default), webhook projects are also checked every 30 minutes, since a push sent while Stackport was down is never redelivered; if that check finds a commit the hook didn't deliver, the hook is marked failing and the project is polled at the normal interval until a delivery succeeds again.

---

## Browser push and email alerts

Configure both channels in **Settings → Notifications**. Browser push has its own enable switch, contact email or HTTPS URL, and per-event preferences for health failures, blocked automatic deployments, unhealthy deployments, failed automatic rollbacks and failed Stackport updates. An optional **Automatic rollback restored service** preference is off by default; enabling it sends a separate recovery alert after successful rollback without changing the original unhealthy-deployment alert. Email remains independently configurable through its existing provider and credential settings. Routine successful operations keep their existing in-app toasts.

After saving push settings, click **Enable on this browser** and accept the browser's permission prompt. Each browser is registered separately; Settings lists registered devices and lets you name the current browser, remove devices and send tests to one or all browsers. Permission is requested only after a click. A blocked permission must be changed in browser site settings. Push requires a secure context and a compatible browser; iPhone/iPad users must install the PWA on the Home Screen.

After login, the app passively checks browsers that opted in and shows a notice on any signed-in page if browser alerts need registration or permission repair. Checks repeat on focus, reconnect and once per minute while visible. The notice links to Notifications settings; it never requests permission or re-registers the browser automatically. Intentionally disabled browsers do not receive repair reminders.

Signing keys are generated automatically at startup and preserved in `push_config` in the persistent SQLite database. The private key uses the same encryption as stored credentials and is never returned to clients. There are no push environment variables to configure. Back up the database **and** the host secrets containing `JWT_SECRET`; repair, updates, rollback and reinstall without purge preserve the identity and subscriptions.

Push messages contain only concise operational metadata. Clicking a notification focuses or opens Stackport at the relevant project or Settings page. Browser push runs in the service worker even when the tab is closed; delivery depends on browser permission and the browser's push service. Expired subscriptions are removed automatically, temporary failures remain registered, and delivery failures cannot fail a deploy or health check. The shared delivery log records email and browser push separately without exposing subscription endpoints or keys.

Automatic alerts are first committed to a SQLite outbox, atomically with their health/deployment classification wherever they share the database. One in-process worker polls every five seconds and submits at most four requests concurrently. Each browser has its own delivery state and retry schedule; restarts and container replacement recover pending work and expired leases. Transient failures retry with bounded backoff, jitter and Retry-After handling. Recovered health incidents, disabled preferences and removed browsers cancel unsent work; re-enabling never replays incidents skipped while disabled. Failure events expire after one to twenty-four hours depending on their type, and terminal history is retained for thirty days with bounded cleanup. See [the reliability contract](docs/web-push-reliability.md) for exact policies.

Provider success means **accepted by the push service**, not displayed or read. Submission is at least once: a crash after acceptance but before committing the result can cause another attempt. Retries share an incident tag while separate incidents have separate tags. A request already in flight cannot be unsent after cancellation. Settings shows pending/retry/failure counts, the worker's last poll and provider acceptance, and diagnoses a signing identity that cannot be decrypted. Its Refresh action reconciles the browser's real subscription after local storage loss or database restore. Removing a browser disables server submissions first, then removes the local capability, with a recovery button for partial failure.

The custom Workbox worker retains asset precaching, old-cache cleanup, automatic activation and client claiming. Existing release polling and Socket.IO feedback continue unchanged. Detached self-update outcomes enqueue once per updater ID/outcome; launch failures are also reported. Host-only CLI operations do not create a detached updater and are not monitored by this channel. An older release can use the additive schema after rollback but cannot drain queued alerts until a worker-capable release returns. Restore must keep the matching database and host secret: a failed identity check is visible and never silently regenerates keys. Identity failures suspend queued deliveries without spending their provider retry budget; they resume automatically after repair if still eligible and unexpired.

## 7. Security model summary

1. Single admin identity; bootstrap and recovery are the only ways to (re)set it, and both use short-lived, single-purpose sessions enforced server-side, never a frontend-only redirect (§3).
2. Machine secrets (`JWT_SECRET`, `WEBHOOK_SECRET`) are generated once by `stackport.sh` and persisted — never regenerated on a normal `install`/`update`/`repair` rerun.
3. Managed applications cannot publish host ports or use host networking — enforced at deploy time, fail-closed (§1.2, §1.4).
4. StackPort owns all deliberate public ingress; a managed app never decides what the host exposes.
5. Nginx config changes are always validated before being applied live, with automatic backup and rollback on failure (§5.2).
6. Stored secrets (GitHub tokens, API keys, per-credential values) are AES-256-GCM encrypted at rest and never echoed back by any API response.
7. Admin-recovery credential generation requires local root (`docker exec` on the daemon socket) — there is no HTTP endpoint that can trigger it.
8. `stackport uninstall` preserves state by default; `--purge` is explicit, strongly confirmed, and refuses to run non-interactively.
9. API tokens for the MCP endpoint are stored only as SHA-256 hashes, shown once, scoped (`read` only today), revocable and optionally expiring. They are accepted only on `/mcp` and admin session tokens are never accepted there (§9).
10. Action output is stored on disk, masked and time-limited (§10). Masking covers stored credentials and the project's managed env values; it can't cover secrets an app prints that Stackport doesn't manage. Note that managed env values themselves are stored in plain text in the database (`project_env_files.variables_json`), unlike credentials.

---

## 9. MCP (read-only, token auth)

Stackport serves a Model Context Protocol endpoint at `https://<stackport-domain>/mcp` (Streamable HTTP, stateless, JSON responses), inside the app process, so it reads the same state the UI does and never writes.

- **Tokens:** created, listed and revoked in Settings → MCP (`/api/api-tokens`, admin session required). Each token is shown once; only its hash and a short display prefix are stored. Every tool call is written to the audit log with the token id, and each token is rate-limited to 120 requests per minute on top of the per-IP limit.
- **Tools:** `stackport_status` (version and project counts), `stackport_list_projects` (repository as `owner/name`, branch, deploy trigger, paused, health, last commit, pending deploy, domains), `stackport_get_project` (the same plus Compose file, last 10 deployments, containers and the running action).
- **Never returned:** anything stored encrypted, credential ids, env files (names or values), nginx extra config, webhook slugs or secrets, build and action logs. Outputs are built field by field in `src/mcp/readModel.ts`; `tests/mcpHttp.test.ts` checks the exact key sets and that planted secrets never appear.
- **Clients:** Claude Code (`claude mcp add --transport http stackport https://<domain>/mcp --header "Authorization: Bearer spk_…"`) and Claude Desktop. claude.ai custom connectors require OAuth, which is not supported yet.

The older stdio server (`npm run mcp`, `src/mcp/server.ts`) is unchanged: it runs as a separate process with direct database access and write tools, and is only reachable by someone who can already run commands in the Stackport container.

---

## 8. Directory layout reference

```
/etc/stackport/
├── stackport.env      # non-secret config (domain, certbot email, ...)
└── secrets.env        # JWT_SECRET, WEBHOOK_SECRET, one-time bootstrap credential

/var/lib/stackport/
├── app/                # StackPort's own git checkout (disposable — not persistent state)
├── data/                # SQLite DB, project repo checkouts
├── logs/
├── nginx/               # nginx config tree (templates, generated config, backups)
├── backups/              # database backups taken before each `stackport update`
├── update/state.env      # current/previous version, last update result
└── certbot-webroot/      # ACME HTTP-01 challenge webroot

/etc/letsencrypt/          # persistent certificate storage (not under /var/lib/stackport)
/usr/local/bin/stackport   # the host lifecycle CLI
```

The application checkout (`/var/lib/stackport/app`) is disposable and rebuildable at any time via `stackport update`/`rollback`; persistent state never lives inside it or inside a container image.

## 10. Actions and their logs

Every action (deploys, pulls, rollbacks, stops, SSL issuance, nginx applies, certbot runs, Docker prunes) goes through one runner, `src/modules/actions/registry.ts`, which allows one action per slot (a project's build/deploy slot, each domain's SSL slot, nginx, ...).

- **History:** each run is a row in the `actions` table: kind, project, status (`running`, `success`, `failed`, `cancelled`, `interrupted`), who or what triggered it, the commit and branch for deploy-type actions, and start and end times. Rows still `running` when Stackport starts are marked `interrupted`: their processes died with the previous Stackport process. This table is also the deploy log behind Insights and "Recent deploys", replacing `project_deploys` (whose rows were copied in once; the table is kept, unwritten, for `stackport rollback`).
- **Output:** numbered chunks, sent every 100 ms to clients that attach over the socket (`action:attach {id, fromSeq}` replays and then streams), and appended to `<LOG_DIR>/actions/<id>.log`. Actions that don't stream (nginx, certbot, SSL, prune) store their final output. `GET /api/actions/:id/log` returns a stored log; `GET /api/actions/running` lists running actions.

**What is stored, and for how long.** Build output often prints environment values, so:

- **Masking:** before output is streamed or written, every stored credential and the project's managed env values (6 characters or longer) are replaced with `***`. A trailing partial line is held back up to a second so a value split across two writes is still caught. Secrets an app prints that Stackport doesn't manage are not masked.
- **Retention:** a log file is kept for the newest 20 runs per slot and never longer than 30 days; action rows (no output) are kept 180 days for Insights. Retention runs after every action and at startup.
- **Deletion:** a project's log files are deleted when the project is deleted, after a successful Stop & Delete Data, and on request (`DELETE /api/projects/:id/action-logs`, the Clear logs button).
- **Permissions:** the directory is `0700` and each file `0600`, owned by the app user.

## Traffic and Docker logs

Traffic uses authenticated `/api/metrics/nginx` and `/api/metrics/nginx/requests` endpoints to read `docker logs stackport-nginx`. Generated access logs include host, user agent and request duration for domain filters, health-check exclusion and response-time statistics. No host log mount or sudo is needed.

Docker retains three rotated 10 MB files. Traffic reads at most 20,000 recent lines and a bounded byte window; selected periods filter retained history and do not guarantee archival coverage. Each traffic response includes `coverage` (the oldest entry read, whether the line or byte cap cut the read short, and any Clear cutoff), and Insights says so whenever the data doesn't span the whole selected period. Container recreation starts new log history. Clearing Traffic stores a persistent cutoff without deleting Docker logs. Custom templates must preserve the `stackport` access-log format and stdout destination.

Host installation and runtime-switch write APIs are removed. Nginx config/template, reload, certificate actions and Docker log APIs remain authenticated and operate on Docker containers.
