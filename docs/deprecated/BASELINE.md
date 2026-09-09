# StackPort Dockerization — Phase 1.0 Baseline

Status: current production behavior as of the start of the Dockerization effort (branch `SP-Docker`, identical to `main` at the time this was written — no prior dockerization work in flight).

This document exists to satisfy the Phase 1.0 gate in `SP_dockerization.md`: destructive migration work must not begin until current production behavior is documented. It is a factual snapshot, not a design document — see `SP_dockerization.md`, `stackport_yml.md`, and `stackport_host_lifecycle.md` for the target architecture, and the roadmap in the corresponding plan for how phases sequence against this baseline.

The acceptance checklist for the eventual Core release is `SP_dockerization.md` §46 — not duplicated here.

---

## 1. Install / update / recovery scripts

All at repo root, none in a `scripts/` subdirectory (that only holds `bump-version.cjs`, a dev-time build helper).

| Script | Run as | Purpose |
|---|---|---|
| `init.sh` | root | Fresh-VPS installer. Installs Docker CE + compose plugin, nginx, Certbot + nginx plugin, Node.js (min major 24). Creates the `stackport` system user (`--system --no-create-home --shell /usr/sbin/nologin`), adds it to the `docker` group (socket access) and `adm` group (nginx log read access). Writes `/etc/sudoers.d/stackport` (see §3). `rsync`-copies the source tree to `/opt/stackport` (excludes `.env`, `node_modules/`, `dist/`, `.git/`, `logs/`). Sets up `.env` (copies existing or from `.example.env`). Prepares `data/`, `data/.home/.config/git`, `data/.npm`, `data/.docker`. Prepares nginx dirs (`templates/`, `backups/`, `sites-available/`) owned by `stackport:stackport`. Runs `npm ci` + `npm run build` + `npm prune --omit=dev` for both backend and `client/`. Writes and starts the systemd unit (§2). |
| `rp_init.sh` | root | Run once after `init.sh`. Bootstraps StackPort's *own* public reverse-proxy vhost: writes an HTTP-only `sites-available/stackport-main-domain.conf`, reloads nginx, issues a cert via `certbot --nginx --cert-name <domain> ...`, rewrites the vhost to a full HTTP→HTTPS + TLS server block, reloads again. Separate from the per-managed-project nginx config the running app generates itself (§5). |
| `bootstrap.sh` | `stackport` (unprivileged) | The in-app self-update script, invoked by `POST /api/system/update[/frontend]` (see §4). Backs up `.env`/`data`/`logs`, `git fetch` + `git pull --ff-only` (or hard-reset on first pull), restores backed-up state, `npm ci` (skipped for backend when `FRONTEND_ONLY=1`) + build + prune, then schedules `sudo -n systemctl restart stackport` via a detached `nohup` (so the restart doesn't kill its own parent mid-command). |
| `redeploy.sh` | root | Standalone SSH recovery script for when the service is crash-looping and can't self-serve the UI update button. Stops the service first, `git fetch` + **`git reset --hard origin/<branch>`** (hard reset, unlike `bootstrap.sh`'s ff-only pull), restores `.env`/`data`/`logs`, rebuilds, `chown` back to the app user, restarts, polls `systemctl is-active` up to 20s. Supports `--clean` to wipe `node_modules`/`dist` first. |
| `remove.sh` | root | Uninstalls: stops/disables the service, removes the systemd unit + sudoers file + `/opt/stackport`, `userdel stackport`, cleans up nginx `templates/`/`backups/`/`state.json`. Does **not** remove Docker, nginx, Certbot, or Node.js. |
| `migration.sh` | root | One-off idempotent patch for pre-existing installs: adds `stackport` to the `adm` group, appends the `truncate` sudoers rule if missing. |
| `pwdrst.sh` | root | Standalone admin-password-reset helper, outside the normal install/update flow. |

## 2. systemd unit

Written by `init.sh` to `/etc/systemd/system/stackport.service`:

```ini
[Unit]
Description=StackPort MW VPS Manager
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=stackport
Group=stackport
WorkingDirectory=/opt/stackport
EnvironmentFile=/opt/stackport/.env
Environment=HOME=/opt/stackport/data/.home
Environment=XDG_CONFIG_HOME=/opt/stackport/data/.home/.config
Environment=NPM_CONFIG_CACHE=/opt/stackport/data/.npm
Environment=DOCKER_CONFIG=/opt/stackport/data/.docker

ExecStart=<node binary path> dist/index.js
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=120
StartLimitBurst=5
TimeoutStopSec=15

StandardOutput=journal
StandardError=journal
SyslogIdentifier=stackport

NoNewPrivileges=no
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=/opt/stackport /etc/nginx /etc/letsencrypt

[Install]
WantedBy=multi-user.target
```

`NoNewPrivileges=no` is required because the service must be able to `sudo -n` (§3). `ReadWritePaths` explicitly grants write access to `/etc/nginx` and `/etc/letsencrypt` on top of `ProtectSystem=full`/`ProtectHome=yes` hardening.

## 3. Privileged operations

A `privileged()` helper is duplicated verbatim in three files (`src/routes/system.ts`, `src/services/nginx/configWriter.ts`, `src/services/certbot.ts`):

```ts
function privileged(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { cmd, args };
  }
  return { cmd: "sudo", args: ["-n", cmd, ...args] };
}
```

Runs the command directly if already root, otherwise prefixes `sudo -n` (non-interactive — fails rather than prompting). Production always takes the `sudo -n` branch (`User=stackport`).

Commands run this way: `nginx -t` / `nginx -t -c <tempfile>`, `systemctl reload nginx`, `certbot` (all subcommands), `openssl x509 -enddate/-issuer`, `test -f <path>` (cert existence), `apt-get` (on-demand nginx/certbot install from the UI), `truncate -s 0 <nginx log paths>`. `bootstrap.sh` also calls `sudo -n systemctl restart stackport` / `is-active` directly as a shell command (not through the shared helper).

The matching sudoers grant, written by `init.sh` to `/etc/sudoers.d/stackport` (mode 440):

```
stackport ALL=(root) NOPASSWD: <nginx> -t, <nginx> -t -c *, <systemctl> reload nginx, <systemctl> restart stackport, <systemctl> is-active stackport, <certbot>, <openssl>, <test>, <apt-get>, <truncate> -s 0 /var/log/nginx/access.log, <truncate> -s 0 /var/log/nginx/stackport.access.log
```

**Docker commands (`docker`, `docker compose`) are never sudo-wrapped** — access is purely via the `stackport` OS user's `docker` group membership (added by `init.sh`).

## 4. Self-update mechanism

- `GET /api/system/update/check` — resolves the configured repo/branch (`APP_GITHUB_REPO`/`GITHUB_REPO` env, else `git remote get-url origin`; `GIT_BRANCH` env, else current HEAD), does `git ls-remote` vs local `git rev-parse HEAD`, reports `hasUpdate`.
- `POST /api/system/update` and `POST /api/system/update/frontend` both call `runAppUpdate(mode)` in `src/routes/system.ts`, which spawns `config.selfUpdateScript` (default `./bootstrap.sh`) as a subprocess of the app itself — **not** a separate privileged service. Injects decrypted GitHub credentials into the child env. `mode === "frontend"` sets `BOOTSTRAP_FRONTEND_ONLY=1`, which inside `bootstrap.sh` skips the backend `npm ci`/build entirely.
- Progress streams over Socket.io (`system:update` events) — the initial POST returns immediately since nginx would 504 on a multi-minute synchronous request. Lines matching `^[bootstrap:step] (.+)$` in the script's output are parsed as the current step shown in the UI.
- The actual restart is performed by `bootstrap.sh` itself (`sudo -n systemctl restart stackport`, detached via `nohup`), not by Node directly.

## 5. Data / config locations

`src/config/env.ts` (loaded via `dotenv.config()`):

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | App listen port |
| `JWT_SECRET` | required | Also the source of the AES-256-GCM key used to encrypt stored credentials (`src/utils/crypto.ts` derives it via SHA-256 — no separate encryption-key env var exists) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | required | Today's admin bootstrap model — a bcrypt hash supplied directly via env var. (`stackport_host_lifecycle.md` proposes replacing this with a generated one-time bootstrap credential — not implemented yet.) |
| `WEBHOOK_SECRET` | required | HMAC secret for incoming webhook validation |
| `SCRIPTS_DIR` | required | Absolute host path where allowed webhook-triggered scripts live |
| `SQLITE_PATH` | `./data/stackport.sqlite` | SQLite DB file |
| `DEPLOY_ROOT` | `./data/repos` | Root directory for managed projects' git checkouts |
| `LOG_DIR` | `./logs` | App logs |
| `NGINX_PATH` | `/etc/nginx` | Root for generated nginx config, templates, backups |
| `SELF_UPDATE_SCRIPT` | `./bootstrap.sh` | Script invoked by §4 |
| `HOSTINGER_API_KEY` / `HOSTINGER_VM_ID` | optional | VPS provider integration |

Every path above is already env-driven, which is what makes containerizing without touching path-handling code feasible — the container just needs these env vars pointed at mounted volumes.

`src/config/database.ts` resolves the SQLite path from `config.sqlitePath` and creates its parent directory before opening (`journal_mode = WAL`, `foreign_keys = ON`).

## 6. Docker access

Plain `child_process` calls (`spawn`/`execFile`) to `docker`/`docker compose` — no sudo wrapping anywhere, relying entirely on OS group membership. `DOCKER_CONFIG` is explicitly set via a `dockerEnv()` helper in `src/services/projectDeploy.ts`: `{ ...process.env, DOCKER_CONFIG: process.env["DOCKER_CONFIG"] ?? path.join(deployRoot(), ".docker") }` — defaults to an isolated docker config dir under the deploy root unless the systemd unit's own `DOCKER_CONFIG` env overrides it (it does, in production: `/opt/stackport/data/.docker`).

The app also shells out directly to `git` (clone/fetch/pull in `ensureRepo`) and reads folder sizes via `du -sb`.

## 7. nginx integration

`src/services/nginx/configWriter.ts`:

- **Single generated file**, not one-per-project: `<NGINX_PATH>/sites-available/default`, rebuilt in full on every apply from two editable templates (`templates/general.conf`, `templates/project.conf`) plus one rendered server-block set per `(project, domain)` pair.
- Every generated `proxy_pass` target is literally `http://127.0.0.1:<project.internalPort>` — hardcoded loopback + the project's single stored `internal_port`.
- Validated with `nginx -t` on a temp candidate before activation; on success, backs up the previous file (`backups/default.<timestamp>.bak`) and records the outcome to `state.json`; on failure, the bad candidate is saved to `failed.conf` and the previous working file stays live. Reload is `systemctl reload nginx` via `privileged()`.
- The `sites-available`/`sites-enabled` symlink split *is* used, but only for the app's own one-time bootstrap vhost (`rp_init.sh`) — separate from the always-regenerated `sites-available/default` covering all managed projects.
- Routing today is **project-level, not service-level**: a domain row (`project_domains` table: `id, projectId, domain, useSsl`) has no port/service field at all — every domain for a project resolves to that project's single `internalPort`. Multi-service compose files are invisible to the routing layer.

## 8. Certificate integration

`src/services/certbot.ts` — shells out to the `certbot` CLI directly (via `privileged()`):

- Issue: `certbot --nginx -d <domain> [-d www.<domain>] --non-interactive --agree-tos -m <email>` (nginx plugin, not webroot/standalone).
- Renew: `certbot renew --cert-name <domain> --non-interactive`. Delete: `certbot delete --cert-name <domain> --non-interactive`.
- Existence/expiry checks via `test -f` + `openssl x509 -enddate/-issuer`.
- Cert location is hardcoded to the real system path `/etc/letsencrypt/live/<domain>/`, independent of `NGINX_PATH`.

## 9. Current port/routing model (pre-`stackport_yml.md`)

- `{{SP:AUTO}}` in a managed project's compose file is resolved once (`src/services/composeSpAuto.ts`) to the lowest free port in `[3100, 4100]` (live TCP bind-tested), persisted to `projects.internal_port`, and substituted into the compose file **on disk, ephemerally** (never committed) as `127.0.0.1:<port>:<container_port>` before every `docker compose` invocation.
- An optional "port hiding" toggle (`src/services/composePortHiding.ts`) rewrites *every* fixed host-port publication (`"HOST:CONTAINER"` → `"127.0.0.1:HOST:CONTAINER"`) the same way, for compose files that don't use `{{SP:AUTO}}` at all.
- **No custom Docker networking exists anywhere** — confirmed via a full-repo grep for `docker network`/`networks:`/`network_mode`. Every managed project relies purely on Compose's own default per-project bridge network, reachable from the host only through its published port.
- No MQTT/non-HTTP exposure mechanism is implemented — HTTP(S) via nginx `proxy_pass` is the only routing path today.

This entire model is what `stackport_yml.md` (Phase 1.7) replaces with `domain -> service -> container_port` routing over a StackPort-owned Docker network, eliminating host-port allocation for managed apps entirely.

## 10. Existing Docker artifacts (pre-Phase-1.1)

- `Dockerfile` (repo root) — a working multi-stage `node:24-bookworm-slim` build packaging StackPort itself, but **not wired into any install path today** (`init.sh` never builds or references it), and missing the `docker`/`git` CLIs the app needs at runtime.
- `Dockerfile.test` + `docker-compose.test.yml` — a test harness that simulates a *clean VPS* (Ubuntu + stubbed `systemctl`) for manually exercising `init.sh`, not a containerization of the app. Unrelated to Phase 1.1 and left untouched.
- No `.dockerignore` existed prior to Phase 1.1.
- `GET /health` already exists (`src/app.ts`) and is the target for the Phase 1.1 container `HEALTHCHECK`.

## 11. Known Phase 1.1 gaps (by design, not regressions)

Once StackPort itself runs in a container (Phase 1.1) but nginx/Certbot are still host-installed:

- Any nginx-reload or Certbot action triggered from inside the container **will fail** — the container image has no `sudo`, `systemctl`, `nginx`, or `certbot` binaries, and even if it did, there's no systemd/D-Bus reachable from inside a standard container to actually reload the host's nginx. This is expected and unaddressed until Phase 1.5 (dockerized nginx) / 1.6 (dockerized certs) move that control inside the system stack.
- Self-update via `bootstrap.sh` will not work in-container (no systemd to restart, and Phase 1.1's own gate says "no runtime npm build is required on the VPS" — building at runtime inside the container contradicts that). Deferred to Phase 1.8 (image-based updater) and/or the `stackport_host_lifecycle.md` host CLI, both explicitly out of scope for Phase 1.1.
- Public ingress is unchanged in Phase 1.1 — the host's existing nginx continues serving real traffic exactly as it does today; the containerized StackPort is a parallel, dev-testable milestone proving the container boundary, not yet the production path.
