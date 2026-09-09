# StackPort — Application Lifecycle

StackPort is a self-hosted DevOps control plane: a Node/Express backend + React client that deploys GitHub-repo or manually-uploaded projects via `docker compose`, fronts them with a self-managed nginx reverse proxy, issues Let's Encrypt certificates, and monitors the host (and optionally a Hostinger VPS fleet). This document walks through its entire lifecycle — from a bare server to day-to-day project management — in the order an operator actually experiences it.

---

## 1. Installation

### 1.1 Prerequisites

A Linux host with `apt-get`, `dnf`, or `yum`, root SSH access, and outbound internet access (to install Docker, nginx, Certbot, Node.js 24+, and to pull the StackPort git repo itself). Nothing else needs to be pre-installed — `init.sh` installs everything.

### 1.2 `init.sh` — first-time install (run once, as root)

From a checkout of the StackPort source (anywhere, e.g. `/root/stackport-src`):

```bash
sudo bash init.sh
```

What it does, step by step:

1. **Installs OS dependencies** if missing: Docker (+ compose plugin), nginx, Certbot (+ `python3-certbot-nginx` plugin), Node.js 24+. Each is skipped if already present at a sufficient version — safe to re-run.
2. **Creates a system user** `stackport` (no login shell, no home dir), adds it to the `docker` group (so it can run `docker compose`) and the `adm` group (so it can read nginx logs without root).
3. **Writes a sudoers policy** at `/etc/sudoers.d/stackport` granting the `stackport` user passwordless root for exactly the commands the app needs to self-manage: `nginx -t`, `systemctl reload nginx`, `systemctl restart/is-active stackport`, `certbot`, `openssl`, and truncating nginx access logs. This is the entire privilege boundary — the app itself never runs as root.
4. **Copies the app** into `/opt/stackport` via `rsync --delete` (excluding `.env`, `node_modules`, `dist`, `.git`, `logs` — so re-running `init.sh` to upgrade in place never destroys live config/data).
5. **Seeds `.env`**: if `/opt/stackport/.env` doesn't exist yet, it's created from `.example.env` and the script **stops immediately**, telling you to edit it before continuing. This is the only interactive step, and it isn't a prompt — you edit the file by hand, then re-run `sudo bash init.sh`. The values you must fill in:
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` — there is no default admin account. Generate the bcrypt hash yourself:
     ```bash
     node -e "require('bcrypt').hash('yourpassword',12).then(console.log)"
     ```
   - `JWT_SECRET`, `WEBHOOK_SECRET` — random secrets, e.g. `openssl rand -hex 32`.
   - `SQLITE_PATH`, `LOG_DIR`, `PORT`, `NODE_ENV`, `ALLOWED_ORIGINS`, `SCRIPTS_DIR` — infra paths/ports, defaults in `.example.env` are usually fine for a single-host install.
6. **Prepares data/nginx directories**: `data/` (SQLite DB lives here), `logs/`, and under `NGINX_PATH` (default `/etc/nginx`) — `templates/`, `backups/`, `sites-available/`, plus placeholder `state.json`/`failed.conf` files, all owned by the app user so it can manage nginx config without root.
7. **Installs dependencies and builds**: `npm ci` (backend + client), `npm run build` (compiles the API and builds the client bundle), then `npm prune --omit=dev` to shed dev dependencies from the shipped install.
8. **Creates and starts the systemd service** `/etc/systemd/system/stackport.service` — runs as the `stackport` user, `Restart=on-failure`, reads `/opt/stackport/.env` as its environment. `systemctl enable --now stackport`.

Re-running `init.sh` later is safe and acts as an in-place reinstall/repair — every step checks whether it's already done before acting, and `.env`/`data/`/`logs/` are never overwritten.

### 1.3 `rp_init.sh` — publish StackPort itself behind a domain (run once, right after `init.sh`)

```bash
sudo bash rp_init.sh
```

`init.sh` gets the app *running* (reachable at `http://<host-ip>:<PORT>`), but doesn't put a domain or TLS in front of it. `rp_init.sh` does that:

1. Reads `MAIN_DOMAIN` from `.env`; if missing, **prompts** for it interactively and saves it back to `.env`.
2. Reads `CERTBOT_EMAIL` from `.env`; if missing, **prompts** for it and saves it back.
3. Writes a plain-HTTP nginx vhost (`/etc/nginx/sites-available/stackport-main-domain.conf`) proxying the domain to `127.0.0.1:<PORT>`, and reloads nginx — this has to happen *before* certificate issuance, since Let's Encrypt's HTTP-01 challenge needs to reach the domain over plain HTTP first.
4. Runs `certbot --nginx --cert-name <domain> -d <domain>` to issue the certificate (skipped if a cert for that domain already exists).
5. Rewrites the same vhost file to the final HTTPS version (redirect-to-HTTPS + TLS server block) and reloads nginx again.

**Before running this**, point your domain's DNS A record at the server's IP — the HTTP-01 challenge requires it. Re-running is safe: domain/email are only prompted for once, and an existing certificate is left alone.

This vhost is a separate, one-time, manually-provisioned file — distinct from the "app nginx" self-publish *toggle* available later inside the app itself (§7.2), which folds StackPort's own route into the same generated config it manages for projects. You can use either approach, but not both for the same domain.

### 1.4 What you end up with

- StackPort running as a systemd service (`stackport`), auto-restarting on crash.
- A SQLite database at `data/stackport.sqlite` (schema created automatically on first app boot — no separate migration step to run).
- Optionally, StackPort itself reachable over HTTPS at `MAIN_DOMAIN`.
- Docker, nginx, and Certbot installed and ready for StackPort to manage on behalf of the projects you deploy through it.

---

## 2. First login

There is no self-service registration and no "first-run wizard" — StackPort is single-admin. The admin identity is whatever you put in `.env` during install (§1.2 step 5).

1. Open the app (its own IP:port, or the domain from `rp_init.sh`) — the root path `/` **is** the login page.
2. Enter the username/password you baked into `.env`. There's no forced password-change prompt; you land straight on the Projects page.
3. A successful login stores a JWT in the browser's `localStorage`. Sessions self-extend on activity — every authenticated API call rotates the token to a fresh expiry window (`JWT_EXPIRY`, default 7 days), so an actively-used session effectively never expires; only 7 days of total inactivity logs you out.
4. **Change your password later**: Settings → Change Password (requires the current password; on success it invalidates *every* session — including the one that just changed it — so you'll be bounced back to the login page immediately after).
5. **Locked out?** SSH to the server and run:
   ```bash
   sudo bash pwdrst.sh
   ```
   from the original source checkout. It prompts for a new password (twice, hidden input), writes the bcrypt hash directly into the SQLite database, and invalidates all sessions. It requires the app to have been started at least once already (so the DB exists). See §4.3.

---

## 3. Managing StackPort itself (day-to-day operation of the app)

### 3.1 Updating StackPort (normal path — do this from the UI)

Settings → Version Control shows the currently-deployed backend/frontend build info (version, git commit, branch) and offers:

- **Check commits** — compares local `HEAD` against the configured remote/branch and reports whether an update is available.
- **Frontend only** — rebuilds and redeploys just the client bundle (fast, no backend restart).
- **Pull, build, restart** — the full update: pulls the latest commit, rebuilds backend + frontend, and restarts the service.

Under the hood, both buttons spawn `bootstrap.sh` (the script configured via `SELF_UPDATE_SCRIPT`, default `./bootstrap.sh`). It runs as the unprivileged app user (it's a child process of the running service):

1. Backs up `.env`, `data/`, `logs/` to a temp dir.
2. `git fetch` + `git pull --ff-only` (refuses to proceed if the history isn't a clean fast-forward — it won't silently discard local drift).
3. Restores the backed-up `.env`/`data`/`logs` over whatever the pull brought in, so the live database and secrets are never clobbered by the repo's own copies.
4. Reinstalls dependencies, rebuilds (`npm run build`), prunes dev dependencies.
5. Schedules `systemctl restart stackport` a couple seconds out, detached — deliberately delayed because the script is a child of the very process it's about to kill.

Progress streams live into the Settings page via a Socket.io channel, parsed into step labels (`[bootstrap:step] ...`) alongside raw output.

If a GitHub credential is required to pull (private repo), select one via the "GitHub credential" selector on the same card first — set with `PUT /api/system/update-config`.

### 3.2 `redeploy.sh` — manual recovery (when the app is too broken for the UI button)

If the service is crash-looping or stuck on a bad build and can't serve the Update button's click at all, SSH in and run this by hand:

```bash
sudo bash redeploy.sh          # normal recovery
sudo bash redeploy.sh --clean  # also wipes node_modules/dist first, for suspected corrupted installs
```

Unlike `bootstrap.sh` (runs as the app user, detaches before restarting itself), `redeploy.sh` runs as **root**, stops the service up front, hard-resets to the remote branch (`git reset --hard origin/<branch>` — not just a fast-forward pull, since this is explicitly the "fix whatever's wrong" path), rebuilds, fixes file ownership, and starts the service back up, polling for up to 20 seconds to confirm it's actually healthy (dumping recent logs if not).

If your git remote is HTTPS (not SSH), you must have already run `gh auth login` once on the server — `redeploy.sh` uses the GitHub CLI's credential helper rather than a token, since GitHub no longer accepts plain password auth over HTTPS.

Must be run from `/opt/stackport` itself (the systemd unit's working directory), not from wherever you originally cloned the source for `init.sh`.

### 3.3 `pwdrst.sh` — admin password reset

Covered in §2. Root-only, out-of-band, bypasses the running app entirely by writing straight to the SQLite database. Safe to re-run any time you need to rotate the password.

### 3.4 `migration.sh` — legacy permissions patch

A narrow, one-off fix for installs set up **before** `init.sh` started granting the app user `adm`-group access to nginx logs. New installs via the current `init.sh` don't need this — it exists purely to backfill older deployments:

```bash
sudo bash migration.sh
sudo systemctl restart stackport   # required — group membership needs a fresh process
```

Safe to re-run; every step checks whether it's already applied.

### 3.5 `remove.sh` — uninstall

```bash
sudo bash remove.sh
```

Stops and disables the systemd service, removes the sudoers file and service unit, and **deletes `/opt/stackport` entirely — including the SQLite database — with no confirmation prompt and no backup**. Deliberately leaves Docker, nginx, Certbot, and Node.js installed (they're general-purpose system packages, not assumed safe to remove), and leaves your nginx `sites-available` configs and Let's Encrypt certificates in place (only warns that they may still reference the now-gone app). Back up `data/stackport.sqlite` first if you need it.

---

## 4. Normal usage — the page map

Once logged in, the sidebar covers:

| Page | Purpose |
|---|---|
| **Projects** | List + create/deploy projects (the core workflow — §5). |
| **System** | Nginx, Docker, Certbot, GitHub Poller, Firewall — tabbed host-management panels. |
| **Infrastructure** | Local host hardware stats + monitored Hostinger VMs. |
| **Integrations** | VPS providers, notification email config. |
| **Credentials** | GitHub tokens and API keys used everywhere else in the app. |
| **Metrics** | Deploy success/failure history, health-check summary, cross-project resource usage. |
| **Traffic** | Nginx access-log analytics (requests, status codes, top paths, anomaly detection). |
| **Logs** | Audit log of every mutating action taken through the app. |
| **Settings** | Password change, app self-update, notification/system-level toggles. |

---

## 5. Managing a project

This is the core day-to-day workflow. A project is either a **GitHub repo** StackPort clones and pulls, or a **manually-uploaded** `docker-compose.yml` (+ support files) with no git backing.

### 5.1 Creating a project — the wizard

Projects → "Add new project" opens a step-by-step wizard:

1. **Repository information** — name the project, then pick a source:
   - **From GitHub**: `owner/repo` (or a full GitHub URL), optionally a specific GitHub credential (falls back to the org-wide default GitHub credential, or unauthenticated for public repos).
   - **Upload files**: no repo — you'll upload a `docker-compose.yml` plus any support files it needs directly.
2. **Pull repository** (GitHub) / **Upload files** (upload) — for GitHub, pick a branch (or the repo's default) and pull; for upload, pick the compose file + any support files and StackPort stages them, dry-run validates them (`docker compose config --quiet`), then swaps them into the live project directory.
3. **Environment files** — optionally add `.env` files the project needs before the first build (can also be done later from the project page — see §5.4).
4. **Build & start** (GitHub only — upload runs compose automatically right after step 2) — runs `docker compose up -d --build`.
5. **Project configuration** — pick a domain, an auto-deploy branch, and whether to issue an SSL certificate immediately.
6. **Finished** — the project is live; jump straight to its detail page.

There is **no internal-port field anywhere in this UI** — see §5.2, ports are entirely automatic.

### 5.2 Compose files and ports — fully automatic

After every real pull (initial clone, a manual "Pull from GitHub", or a poller-triggered auto-deploy pull), StackPort:

1. Scans the repository root for `*.yml`/`*.yaml` files and records them as the project's available compose files (`docker-compose.stackport.yml` is preferred if present, then `docker-compose.yml`, then whatever's found first alphabetically).
2. Resolves/persists which one is active.
3. Assigns an internal port — either by allocating one from StackPort's own pool (if the compose file uses the `{{SP:AUTO}}` placeholder token in a `ports:` entry) or by reading a literal published port straight out of the YAML. Once assigned, a project's port is **sticky** — it's never silently reassigned on a later pull.

**There is no manual port field, dropdown, or override anywhere in the UI** — a project can only ever be routed on a port StackPort itself resolved, since nothing else would actually match what the container publishes. To see the resolved port: use the "view docker-compose.yml" button next to the compose-file selector on the project page (opens a read-only modal showing the file as it currently sits on disk, including the substituted port), or check the nginx/docker panels under System, which display live resolved routes.

If a project has multiple compose files, a selector on the wizard's config step and the project page lets you choose which one is active.

**If the previously-active compose file disappears** after a pull (e.g. renamed/removed upstream), the deploy is a hard stop rather than a silent fallback to a different file — and if the pull was poller-triggered (automatic), an alert email fires if notifications are configured (§10).

### 5.3 Actions: pull, build, deploy, compose, recreate, force-rebuild, stop

From the project page's action bar/menu:

- **Pull from GitHub** — fetch + fast-forward pull (discarding any local drift in the checkout first, since it's a deploy target, not a workspace), then re-syncs compose files/port as above.
- **Docker Compose** — `docker compose up -d --build` against the currently checked-out code (no pull first).
- **Deploy** — pull, then build+up in one action (what the GitHub poller triggers automatically on new commits).
- **Force Recreate** — `up -d --build --force-recreate`, for when Compose's own diff misses a change and keeps a stale container running.
- **Force Rebuild** — `build --no-cache` then `up -d --force-recreate`, the heavier hammer for when Docker's build cache is stubbornly reusing a stale layer (e.g. a baked-in env file that changed).
- **Re-upload files** (upload-sourced projects only) — replaces the whole compose directory with freshly uploaded files, then reruns compose. Re-upload replaces everything, not just changed files.
- **Stop** — `docker compose down`.
- **Stop & Delete Data** — `docker compose down -v`, also removing volumes. Confirmation-gated, destructive.
- **Pause/Resume** — pausing removes the project from nginx routing (its server blocks are dropped on the next apply) without touching its containers or data; resuming restores routing.

All of these stream live output to the project page over a websocket, and are recorded in the "Recent deploys" list with a manual/auto tag.

### 5.4 Env files

A project can have any number of named `.env` files, each with its own relative path inside the repo checkout (e.g. `front/.env`, `api/.env`) and a table of `KEY=value` pairs. Managed from the project page's Env Files card (create/edit/import-from-file/delete); written to disk right before every build/deploy action so they're always current when `docker compose` runs.

### 5.5 Domains and SSL

A project can have multiple domains, each independently routable and independently SSL-toggleable, all proxying to the same internal port:

1. Add a domain on the project page.
2. Toggle "Use SSL" (only enabled once Certbot is installed and an email is configured, §7.2) or use the "Issue cert" button directly.
3. Issuance sequences safely around the chicken-and-egg problem of needing a live HTTP route before Let's Encrypt's challenge can succeed: SSL is forced off → nginx applied (plain HTTP route live) → certificate issued via `certbot --nginx` → SSL flag flipped on → nginx applied again with the final HTTPS block. See §7.3 for the full mechanics.
4. Renew/delete a certificate independently per domain later; StackPort's own expiry tracking flags certs as `expiring` inside 30 days.

**Extra nginx customization** per project (not per domain): "Extra Nginx config" (raw directives appended inside the proxy `location` block, e.g. `client_max_body_size`) and "Extra Nginx blocks" (raw server-level blocks appended after the main location, HTTPS server only — supports a `{{PORT}}` placeholder for the project's resolved internal port).

### 5.6 Auto-deploy (GitHub poller)

Set a project's "Auto-deploy branch" (in the wizard or the project page's config form) and enable the GitHub Poller globally (System → GitHub Poller tab). On its configured interval, StackPort checks every project with an auto-deploy branch set for a new commit; if found, it triggers a full `pullProject`-then-build deploy automatically (recorded as `triggeredBy: auto` in the deploy history, distinct from manual clicks). "Poll now" on the same panel triggers an immediate check without waiting for the interval.

### 5.7 Health checks

Set an endpoint path (e.g. `/health`) and a check interval on the project's config form; StackPort polls it and shows up/down status on the Projects list and project page. A failed check (when notifications are configured) fires an alert email.

### 5.8 Docker containers, logs, and shell access

The project page's Docker card lists every container in the project's compose stack (state, status, ports), with per-container actions to open a live interactive shell (xterm-based, in a modal) or stream live logs — plus a static log fetch (choose tail length/service) for quick inspection without a live stream.

### 5.9 Resource usage

Per-project CPU/memory/network charts (5-minute buckets, last 24h by default) on the project page, and a cross-project rollup on the Metrics page for comparing projects against each other.

### 5.10 Deleting a project

Removes the project's configuration and detaches it from health checks — this does **not** run `docker compose down` for you first; stop the stack manually beforehand if you want containers/volumes cleaned up too.

---

## 6. Nginx management

StackPort owns a single generated file, `<NGINX_PATH>/sites-available/default`, fully regenerated from two editable templates plus live project/domain state every time it applies:

- **General template** (`templates/general.conf`) — rendered once: the shared log format, default catch-all HTTP→HTTPS redirect, and a reject-unknown-hosts fallback.
- **Project template** (`templates/project.conf`) — rendered once per routed target (each project×domain pair, plus StackPort's own self-publish route if enabled): HTTP block, HTTPS block, and `www` redirect pairs for apex domains.

Both are plain text and directly editable from System → Nginx → "Nginx files" (Generated/Failed/General/Project tabs) — editing General or Project and saving re-applies immediately.

**What triggers a regeneration+apply**: project create/delete/pause/resume, a project's internal port or nginx-extra-config changing, any domain add/remove/SSL-toggle, a certbot action, the app-nginx self-publish config changing, editing a template, or hitting the manual Apply/Reload buttons on the System page.

**Safety**: every apply validates the candidate with `nginx -t` **before** touching the live file. If validation fails, the live config is never touched and the bad candidate is saved to a "Failed" document for inspection. If it passes, the current live file is backed up (timestamped, under `backups/`) before being replaced; if the *post-replace* `nginx -t` or the subsequent `systemctl reload nginx` fails, the backup is automatically restored. The System page's Nginx tab shows the last-apply result (ok/restored/output) and a running restart count.

**Publishing StackPort itself through this same layer** (as an alternative to the standalone `rp_init.sh` vhost from §1.3): System → Nginx → the app-nginx panel — toggle "Publish StackPort through Nginx", set a domain, optionally enable HTTPS. This folds StackPort's own UI into the exact same generated config and backup/rollback machinery as every project, rather than living in a separate hand-provisioned file.

**Install nginx from the UI**: if nginx isn't detected, an "Install" button on the System page's Nginx tab runs the apt/dnf/yum install and `systemctl enable --now nginx` for you — equivalent to what `init.sh` already does, useful if it was skipped or removed.

---

## 7. Certbot / SSL certificates

### 7.1 Prerequisites

Certbot + the nginx plugin (installed by `init.sh`, or via the System page's Certbot tab "Install" button if missing), and an email address for Let's Encrypt notices — set once under System → Certbot → email field. Issuance fails immediately without an email configured.

### 7.2 What a domain needs before you can issue a cert for it

The domain must already be **routed** — i.e. attached to a project (or the app-nginx self-publish domain) and present in the live nginx config's domain list. StackPort rejects certbot actions against domains it doesn't already know about.

### 7.3 Issue / renew / delete

- **Issue**: `certbot --nginx -d <domain> [-d www.<domain>]` (the `www.` alias is requested automatically for apex domains). Sequenced safely to avoid the chicken-and-egg problem — see §5.5 point 3 for the exact steps. Each stage streams a live progress event to the UI.
- **Renew**: `certbot renew --cert-name <domain>`.
- **Delete**: `certbot delete --cert-name <domain>`.

All three are per-domain actions available both on individual project pages (next to each domain) and in aggregate on System → Certbot (which lists every routed domain with expiry/issuer/status and the same three buttons — this path doesn't do the two-phase SSL-off/on dance, since it assumes the domain's routing state is already correct going in).

### 7.4 Status

Certificate status is computed by checking for `/etc/letsencrypt/live/<domain>/fullchain.pem` directly and reading its expiry via `openssl x509`, bucketed as `missing` / `valid` / `expiring` (within 30 days) / `expired` / `unknown`.

---

## 8. Credentials

Credentials → one shared table backing everything else in the app that needs a secret: GitHub personal-access tokens (used for private-repo cloning, the GitHub poller, and self-update pulls) and API keys (used for the notification email provider and Hostinger VPS/firewall access). Secrets are AES-256-GCM encrypted at rest and never returned by any API response — only metadata (alias, type, username/header name, "default" flag) is ever visible again after creation.

One GitHub credential can be marked **default** — it's the fallback used anywhere a specific credential isn't explicitly chosen (a project without its own GitHub credential, or the GitHub poller if it has none configured).

---

## 9. Notifications

Integrations → Notifications card: enable/disable, pick a provider (Resend or an internal "MW" email gateway), an API-key credential, a from/to address, and a "Send test" button. Once configured, two events fire alert emails automatically:

- A health check transitioning to failing.
- An automatic (poller-triggered) deploy getting blocked — e.g. its active compose file vanished after a pull.

Every send attempt (including manual tests) is logged to an email log visible right on the same card.

---

## 10. VPS monitoring and firewall (Hostinger)

Integrations → register a Hostinger provider (name + API-key credential), then explicitly choose which of that account's VMs to monitor — this isn't automatically "the host StackPort runs on" unless you point it there (a `HOSTINGER_API_KEY`/`HOSTINGER_VM_ID` env-var shortcut can auto-provision that specific self-monitoring case at boot). Monitored VMs show CPU/RAM/disk/network/uptime on the Infrastructure page, with force-refresh and a destructive hard-reboot action.

Firewall rules are staged locally (System → Firewall tab) as reusable profiles, then explicitly **synced** to a Hostinger firewall object and optionally activated against a chosen VM — this manages the cloud provider's firewall API, not the host's own iptables/ufw. Deleting a local profile does not touch anything already synced remotely.

---

## 11. Host-level monitoring (Infrastructure & System pages)

- **Local host** (Infrastructure page) — CPU%, memory, load average for the machine StackPort's own process runs on, plus history charts. Independent of the Hostinger VPS monitoring above.
- **Docker** (System → Docker tab) — engine version, `docker system df` disk usage with a one-click build-cache prune, and every container grouped by compose project into **stacks** (with up/down/build/log/shell actions) versus **standalone containers** not belonging to any known StackPort project. Also hosts the **port-hiding toggle**: when enabled, every project's next build/deploy rewrites its compose file's published ports to bind `127.0.0.1` only, so containers are reachable exclusively through the nginx reverse proxy — it applies on each project's next build/deploy and doesn't retroactively touch already-running containers.

---

## 12. Metrics & Traffic

- **Metrics** — deploy success/fail history (daily bar chart), health-check up/total summary, notification send success rate, and a cross-project resource-usage comparison.
- **Traffic** — tails nginx's access log(s) and parses StackPort's own extended log format (adds host + request-time fields): total requests, error rate, status-code breakdown, per-domain stats, response-time percentiles, bot detection, and a live anomaly table flagging scanner traffic, injection probes, and malformed requests. Can exclude the server's own IP and health-check traffic from the numbers.

---

## 13. Audit log

Every mutating action taken through the app (project create/deploy/delete, domain changes, credential edits, SSL issuance, config saves, logins/logouts, self-updates — dozens of call sites across every route) is recorded with actor, action, target, result, and optional metadata. Browsable and filterable (actor/action/target/time-range) on the Logs page, auto-refreshing every 15 seconds. Stored both in a capped in-memory buffer and appended to `logs/audit.log` on disk, with recovery from the general app log if the dedicated audit file is ever lost.

---

## 14. Security model summary

- Single admin account, credentials set entirely via `.env` before first boot — no self-registration.
- JWTs are additionally tracked server-side in a database table, making them properly revocable (logout, password change, and `pwdrst.sh` all delete the relevant rows), not just self-expiring.
- The app process itself never runs as root; every privileged host operation (nginx reload/test, certbot, restarting the app's own systemd service) goes through a narrowly-scoped, non-interactive sudoers policy written once by `init.sh`.
- Stored secrets (GitHub tokens, API keys) are encrypted at rest and never echoed back by the API.
- Nginx config changes are always validated before being applied live, with automatic backup and rollback on failure.
