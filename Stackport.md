# StackPort — Technical Overview

StackPort is a self-hosted DevOps control plane: a Node/Express backend + React client that deploys GitHub-repo or manually-uploaded projects via `docker compose`, fronts them with its own containerized nginx reverse proxy, issues Let's Encrypt certificates, and monitors the host (and optionally a Hostinger VPS fleet) — all from a single admin UI/API.

StackPort itself runs entirely in Docker. There is no host-installed nginx, Certbot, or Node.js runtime to manage — the only host-level footprint is Docker itself, the `stackport` management CLI, and a small amount of persistent state under `/etc/stackport` and `/var/lib/stackport`. This document describes the system as it exists today; see `docs/deprecated/` for the design docs that shaped it (kept as historical record, not current reference) and `Skills.md` for the operational guide to preparing a repository for deployment.

---

## 1. Architecture

### 1.1 System plane vs. workload plane

Everything StackPort itself needs to run — its own container, its own nginx, its own network — lives in one pinned Docker Compose project named `stackport` (`docker-compose.system.yml`). Every project an operator deploys through StackPort is a **separate** Compose project, isolated from the system plane and from each other. `src/services/systemResources.ts` draws this line by checking a container's `com.docker.compose.project` label — "system" is exactly the containers belonging to the `stackport` project, everything else is a managed workload.

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

Managed projects never publish a host port. `docker-compose.system.yml` declares a shared bridge network, `stackport-proxy`; the `stackport` app and `stackport-nginx` both join it, and every project's compose file gets an **ephemeral, never-committed** rewrite (`src/services/composeNetworking.ts`) adding `networks: [default, stackport-proxy]` to whichever service(s) a domain is routed to. Nginx reaches a project by Docker DNS service name over that network (`http://<service>:<containerPort>`), not `127.0.0.1:<port>`.

`docker-compose.system.yml`'s `nginx` service is the only thing that publishes host ports — `80:80` and `443:443`. A managed project's compose file that includes a `ports:` entry (any form) or `network_mode: host` is **rejected outright** by `src/services/composePolicy.ts` at deploy time, with an actionable error pointing at `expose:` instead. This is a hard, fail-closed invariant, not a default that can be silently bypassed: StackPort decides what the host exposes publicly, not the application being deployed.

### 1.3 Domain routing model

A domain doesn't route to "a project" — it routes to a specific `(service, container_port)` pair within that project's compose file (`project_domains.service` / `project_domains.container_port`). One project can have several domains, each pointing at a different service if it needs to (e.g. a public web frontend on one domain, an admin API on another). `src/services/nginx/configWriter.ts`'s `generateNginxConfig()` builds one nginx server block per routed domain, proxying to `http://<service>:<containerPort>` — see `docs/deprecated/stackport_yml.md` for the original design rationale.

### 1.4 Compose security policy

`composePolicy.ts` runs on every `docker compose up`/`config` invocation and rejects, with a specific actionable message per violation:

- `ports:` (short or long form) — no host port publication.
- `network_mode: host` / `pid: host` / `ipc: host`.
- Dangerous `cap_add` entries and `privileged: true`.
- Bind-mounting dangerous host paths (`/`, `/etc`, the Docker socket, etc.).

A rejected compose file blocks the deploy entirely — StackPort never silently rewrites a project's `ports:` into something "safe" the way earlier iterations of this system did (the retired `SP:AUTO`/port-hiding mechanisms). If your compose file needs a container-internal port reachable, use `expose:`, and register the public route via a domain (§1.3).

### 1.5 Deployment revisions & rollback

Every successful `up` records a `project_deployments` row: the resolved git commit SHA, branch, compose file name, and both the *source* compose content (as pulled from git) and the *effective* compose content (after StackPort's own network-augmentation rewrite) — the exact bytes that actually ran. A failed/rejected deploy records a `failed` row with the blocking reason instead, without touching the currently-active revision. `ensureRepo` pins each deploy to an exact commit SHA (detached HEAD), not a floating branch — deploys are reproducible, not "whatever `git pull` happened to bring in."

`rollbackProject()` finds the previous successful revision, checks out its exact SHA, restores its stored *effective* compose content directly (not a fresh git checkout + re-augmentation), and redeploys from that artifact. Exposed as `POST /:id/rollback` and a "Roll back" button on the project detail page's deployment history list.

### 1.6 Docker storage management

Unbounded image/build-cache growth on a long-running host is a real failure mode, so StackPort manages it actively (`src/services/dockerStorage.ts`, `dockerStorageMonitor.ts`):

- A background monitor periodically checks `docker system df` against configurable thresholds and surfaces storage state (ok/warning/critical) on the System page.
- A pre-build disk-pressure guard runs before every build — if free space is critically low, the build is blocked with a clear message rather than being allowed to run the host out of disk mid-build.
- Manual build-cache pruning is one click on the System → Docker tab.

---

## 2. Installation and host lifecycle — `stackport.sh`

Installation and ongoing host management go through one script, `stackport.sh`, which also installs itself as `/usr/local/bin/stackport`. Full command semantics live in `docs/deprecated/stackport_host_lifecycle.md` (the original design doc — commands below match what's actually implemented).

```bash
curl -fsSL <stackport-install-url> -o stackport.sh
chmod +x stackport.sh
sudo ./stackport.sh install
```

`install` is fully idempotent — safe to rerun; it never regenerates secrets, never recreates the bootstrap admin on an already-initialized install, and never wipes data. It:

1. Detects the OS, ensures Docker is installed.
2. Creates `/etc/stackport` (config/secrets) and `/var/lib/stackport/{data,logs,nginx,backups,update,certbot-webroot}` (persistent state) and `/etc/letsencrypt` (standard system certbot path — kept separate from `/var/lib/stackport` so certs stay interoperable with any host-native certbot tooling).
3. Writes `/etc/stackport/stackport.env` — asks **only** for a domain (optional — blank means a raw-IP install) and, if a domain was given, a Certbot/ACME email. Everything else is generated, derived, or defaulted; no hand-written `.env` is required.
4. Writes `/etc/stackport/secrets.env` — generates `JWT_SECRET`/`WEBHOOK_SECRET` (`openssl rand -hex 32`) and, on a genuinely fresh install, a one-time bootstrap credential (`openssl rand | base32`, ~80 bits, dash-formatted), **printed to the terminal exactly once**.
5. Configures `ufw` (SSH detected and allowed first, then 80/443/8883, default-deny the rest) if `ufw` is present.
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

The same update/rollback mechanism backs both the CLI and the UI's Settings → "Rebuild & restart" button (`src/routes/system.ts`'s `runContainerSelfUpdate()`) — there's one update engine, not two.

---

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

A successful login stores a JWT client-side; every authenticated call rotates it to a fresh expiry window (`JWT_EXPIRY`, default 7 days) — an actively-used session effectively never expires. Tokens are additionally tracked server-side (`auth_tokens` table), making them properly revocable: logout, password change, and admin-recovery all delete the relevant rows rather than just waiting for expiry.

---

## 4. Managing StackPort itself (day to day)

Settings → Version Control mirrors `stackport update`/`rollback` (§2) through the UI — the button available depends on `nginx_runtime` (§5.1): host-mode installs keep the original git-pull-and-restart flow (`bootstrap.sh`); container-mode installs get "Rebuild & restart", which triggers the same `docker compose up -d --build stackport` the CLI uses and polls `/health` to reconnect once the container swap completes (the WebSocket connection necessarily drops mid-swap — this is expected, not an error state).

---

## 5. Nginx and certificates

### 5.1 `nginx_runtime`: host vs. container

A single toggle (System page) governs both nginx control and certificate issuance mode, since they're coupled:

- **`container`** (the target/default model) — nginx runs as `stackport-nginx` (`docker-compose.system.yml`), controlled via `docker exec`. Certificates are issued via ephemeral `docker run --rm certbot/certbot certonly --webroot ...` containers using the shared `/var/lib/stackport/certbot-webroot` (mounted into both `stackport-nginx` and each ephemeral certbot run) — no persistent certbot container needed, no new privilege beyond the Docker socket access StackPort already has.
- **`host`** — legacy/dev path: host-installed nginx via `systemctl`, host-installed certbot via the `--nginx` plugin.

### 5.2 Config generation, validation, and rollback

StackPort owns one generated file, `<NGINX_PATH>/sites-available/default`, rebuilt from two editable templates (`templates/general.conf`, `templates/project.conf`) plus live project/domain state on every apply. Every apply validates the candidate (`nginx -t`, run against whichever runtime is active) **before** touching the live file; a validation failure leaves the live config untouched and saves the bad candidate to a "Failed" document for inspection. A successful validate-and-replace backs up the previous live file first; if the post-replace test or reload fails, the backup is restored automatically. Both templates are directly editable from System → Nginx.

### 5.3 HTTPS with no domain — self-signed bootstrap

A raw-IP install (§2 step 3, blank domain) still needs HTTPS for the very first login. `src/services/appIngress.ts`'s `ensureAppIngress()` runs once at boot: if no app domain is configured and no domain was supplied, it generates a long-lived self-signed certificate (`src/services/nginx/selfSignedCert.ts`, via an ephemeral `docker run` since the app's own `/etc/letsencrypt` mount is deliberately read-only) and nginx serves it as the HTTPS `default_server` — reachable at `https://<server-ip>/` with a browser trust warning, but encrypted. The moment a real app domain is configured (via System → Nginx, or `STACKPORT_DOMAIN` at install time), StackPort automatically runs the same three-stage HTTP→issue→HTTPS flow used for projects (below) and the self-signed fallback is superseded — no manual cleanup needed.

### 5.4 Per-project SSL issuance

Issuance is sequenced to avoid the chicken-and-egg problem of needing a live HTTP route before Let's Encrypt's HTTP-01 challenge can succeed:

1. SSL forced off, nginx applied (plain HTTP route live, ACME challenge location active).
2. Certificate issued.
3. SSL flag flipped on, nginx applied again with the final HTTPS block.

A background monitor (`certbotRenewalMonitor.ts`) sweeps `docker run --rm certbot/certbot renew` on a daily cadence once `nginx_runtime` is `container` — no in-app scheduler is needed for the host-mode path since the host's own `certbot.timer` handles it.

---

## 6. Managing a project

### 6.1 Creating a project

Projects → "Add new project" — GitHub repo or manually-uploaded compose file. The wizard's domain step asks for the domain **and** which compose service + container port it should route to (§1.3) — there is no internal-port field anywhere in the UI; ports are never published to the host at all.

### 6.2 Compose requirements

- `expose:` the container-internal port your app listens on — never `ports:`.
- No `network_mode: host`, no `privileged: true`, no dangerous bind mounts (§1.4) — a violating file is rejected at deploy time with a specific error, not silently rewritten.
- The service you register a domain against must actually exist in the compose file (validated server-side before the domain is saved).

See `Skills.md` for the full operational checklist (this is what the StackPort MCP server's `stackport://skills/project-prep` resource also serves).

### 6.3 Actions

Pull, Docker Compose (no pull), Deploy (pull+build+up, what auto-deploy triggers), Force Recreate (`--force-recreate`), Force Rebuild (`build --no-cache` + `--force-recreate`), Stop, Stop & Delete Data (destructive, confirmation-gated), Pause/Resume (pausing drops the project from nginx routing without touching containers/data), and Rollback (§1.5). All stream live output over WebSocket and record deploy history.

### 6.4 Env files, auto-deploy, health checks

Unchanged in shape from earlier versions of the system: named `.env` files per project (written to disk right before every build/deploy), an auto-deploy branch the GitHub poller watches, and a health-check endpoint/interval StackPort polls independently.

---

## 7. Security model summary

1. Single admin identity; bootstrap and recovery are the only ways to (re)set it, and both use short-lived, single-purpose sessions enforced server-side, never a frontend-only redirect (§3).
2. Machine secrets (`JWT_SECRET`, `WEBHOOK_SECRET`) are generated once by `stackport.sh` and persisted — never regenerated on a normal `install`/`update`/`repair` rerun.
3. Managed applications cannot publish host ports or use host networking — enforced at deploy time, fail-closed (§1.2, §1.4).
4. StackPort owns all deliberate public ingress; a managed app never decides what the host exposes.
5. Nginx config changes are always validated before being applied live, with automatic backup and rollback on failure (§5.2).
6. Stored secrets (GitHub tokens, API keys, per-credential values) are AES-256-GCM encrypted at rest and never echoed back by any API response.
7. Admin-recovery credential generation requires local root (`docker exec` on the daemon socket) — there is no HTTP endpoint that can trigger it.
8. `stackport uninstall` preserves state by default; `--purge` is explicit, strongly confirmed, and refuses to run non-interactively.

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

/etc/letsencrypt/          # standard system certbot path (not under /var/lib/stackport)
/usr/local/bin/stackport   # the host lifecycle CLI
```

The application checkout (`/var/lib/stackport/app`) is disposable and rebuildable at any time via `stackport update`/`rollback`; persistent state never lives inside it or inside a container image.
