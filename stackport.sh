#!/usr/bin/env bash
# StackPort host lifecycle CLI — see stackport_host_lifecycle.md for the full design.
#
# First run:
#   curl -fsSL <stackport-install-url> -o stackport.sh
#   chmod +x stackport.sh
#   sudo ./stackport.sh install
#
# `install` also copies itself to /usr/local/bin/stackport, so afterward:
#   stackport status
#   sudo stackport update
#   sudo stackport rollback
#   sudo stackport repair
#   sudo stackport admin-recovery
#   sudo stackport uninstall [--purge]
#
# This script owns StackPort's own infrastructure only (containers, network, nginx
# scaffold, secrets, firewall). Managed application deployment/rebuild/rollback/logs
# stay inside StackPort itself (the web UI / its own API) — see
# stackport_host_lifecycle.md's Purpose section.
set -euo pipefail

# ── Paths & constants ──────────────────────────────────────────────────────────
# Overridable via env — production installs never set these (so behavior is
# unchanged), but it lets this script be exercised against a scratch sandbox
# instead of the real host paths.

ETC_DIR="${ETC_DIR:-/etc/stackport}"
VAR_DIR="${VAR_DIR:-/var/lib/stackport}"
APP_DIR="${APP_DIR:-$VAR_DIR/app}"
STACKPORT_ENV_FILE="$ETC_DIR/stackport.env"
SECRETS_ENV_FILE="$ETC_DIR/secrets.env"
STATE_FILE="$VAR_DIR/update/state.env"
COMPOSE_FILE="$APP_DIR/docker-compose.system.yml"
CLI_TARGET="/usr/local/bin/stackport"

# Real StackPort source location/branch — overridable for testing via env, but this
# is what a fresh `install` clones by default.
STACKPORT_REPO="${STACKPORT_REPO:-https://github.com/vtmattedi/Stackport.git}"
STACKPORT_BRANCH_DEFAULT="${STACKPORT_BRANCH:-main}"

# ── Logging ─────────────────────────────────────────────────────────────────────
# Never print secrets here — generated credentials are echoed exactly once, directly
# by the function that generates them (ensure_secrets), never via log/warn/error.

log()   { printf '[stackport] %s\n' "$*"; }
warn()  { printf '[stackport] WARNING: %s\n' "$*" >&2; }
error() { printf '[stackport] ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  stackport install [--domain=<domain>] [--email=<email>] [--branch=<branch>] [--yes]
  stackport update
  stackport rollback
  stackport status
  stackport repair
  stackport admin-recovery
  stackport uninstall
  stackport uninstall --purge

install:  set up or reconcile a StackPort installation (idempotent).
update:   pull/rebuild/recreate StackPort itself, with automatic rollback on a
          failed health check. Never touches managed projects.
rollback: revert StackPort itself to the previous known-good version.
status:   non-mutating inspection of the current installation.
repair:   reconcile StackPort-owned infrastructure (network, nginx scaffold,
          directory permissions) without touching admin/secrets/certs/project data.
admin-recovery: root+interactive only — generates a temporary credential to reset
          StackPort's administrator password.
uninstall: remove StackPort's runtime, preserving /etc/stackport and
          /var/lib/stackport so it can be reinstalled/recovered later.
uninstall --purge: also permanently deletes that preserved state. Requires typed
          confirmation; refuses to run non-interactively.
EOF
}

# ── Guards ────────────────────────────────────────────────────────────────────

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    error "this command requires root (use sudo)."
    exit 1
  fi
}

require_interactive_tty() {
  if [[ ! -t 0 ]]; then
    error "this command must be run interactively."
    exit 1
  fi
}

# ── Small helpers ─────────────────────────────────────────────────────────────

# Flat key=value state (not JSON — this script has no JSON parser dependency and
# nothing else reads state.env, so plain sourceable lines are simpler than adding
# one). Holds the same current/previous/lastUpdate concept as
# stackport_host_lifecycle.md §10.2's example.
state_get() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] && grep -m1 "^${key}=" "$STATE_FILE" 2>/dev/null | cut -d= -f2- || true
}

state_set() {
  local key="$1" value="$2"
  mkdir -p "$(dirname "$STATE_FILE")"
  touch "$STATE_FILE"
  if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$STATE_FILE"
  else
    echo "${key}=${value}" >> "$STATE_FILE"
  fi
}

stackport_port() {
  grep -m1 '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || echo 3000
}

healthcheck_stackport() {
  local attempts="${1:-30}" i
  for ((i = 0; i < attempts; i++)); do
    if curl -fsS -o /dev/null "http://localhost:$(stackport_port)/health" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Process health alone does not prove that the first-login HTTPS route is ready.
healthcheck_ingress() {
  local attempts="${1:-${STACKPORT_INGRESS_ATTEMPTS:-180}}" domain i
  domain="$(grep -m1 '^STACKPORT_DOMAIN=' "$STACKPORT_ENV_FILE" | cut -d= -f2-)"
  for ((i = 0; i < attempts; i++)); do
    if [[ -n "$domain" ]]; then
      if curl --noproxy '*' --max-time 5 -fsS --resolve "$domain:443:127.0.0.1" -o /dev/null "https://$domain/health" 2>/dev/null; then return 0; fi
    elif curl --noproxy '*' --max-time 5 -kfsS -o /dev/null https://127.0.0.1/health 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

compose() {
  docker compose -f "$COMPOSE_FILE" --project-directory "$APP_DIR" "$@"
}

# ── install: individual ensure_* steps ───────────────────────────────────────

ensure_supported_os() {
  if [[ ! -f /etc/os-release ]]; then
    warn "cannot detect OS (missing /etc/os-release) — continuing anyway"
    return
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    ubuntu:*|debian:*|*:*debian*)
      log "detected supported OS: ${PRETTY_NAME:-$ID}"
      ;;
    *)
      warn "StackPort targets Ubuntu/Debian (detected ${PRETTY_NAME:-${ID:-unknown}}) — continuing, but ufw/apt-based steps may not work."
      ;;
  esac
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker already installed ($(docker --version))"
    return
  fi
  log "installing Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
}

ensure_prerequisites() {
  local cmd missing=0
  for cmd in curl git openssl; do
    command -v "$cmd" >/dev/null 2>&1 || missing=1
  done
  if [[ "$missing" == 1 ]]; then
    command -v apt-get >/dev/null 2>&1 || { error "install curl, git and openssl before continuing"; exit 1; }
    apt-get update
    apt-get install -y curl git openssl ca-certificates
  fi
}

ensure_directories() {
  mkdir -p "$ETC_DIR"
  mkdir -p "$VAR_DIR/data" "$VAR_DIR/logs" "$VAR_DIR/nginx" "$VAR_DIR/backups" "$VAR_DIR/update"
  # Matches the exact path CERTBOT_WEBROOT_PATH is hardcoded to in
  # src/services/nginx/configWriter.ts — must stay in sync with that constant.
  mkdir -p "$VAR_DIR/certbot-webroot"
  # Standard system certbot/Let's Encrypt path (not under $VAR_DIR) — chosen in
  # Phase 1.6 so certs stay interoperable with any host-native certbot tooling,
  # rather than being walled off into a StackPort-specific location.
  mkdir -p /etc/letsencrypt
  chmod 700 "$ETC_DIR"
  chown -R "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$VAR_DIR/data" "$VAR_DIR/logs" "$VAR_DIR/nginx" 2>/dev/null || true
  log "directories ready under $ETC_DIR and $VAR_DIR"
}

ensure_configuration() {
  if [[ -f "$STACKPORT_ENV_FILE" ]]; then
    log "persistent configuration found ($STACKPORT_ENV_FILE)"
    return
  fi

  local domain="${ARG_DOMAIN:-}" email="${ARG_EMAIL:-}"

  if [[ -z "$domain" && "$NONINTERACTIVE" != "1" && -t 0 ]]; then
    read -r -p "StackPort domain (leave blank for a raw-IP install): " domain || true
  fi
  if [[ -n "$domain" && -z "$email" && "$NONINTERACTIVE" != "1" && -t 0 ]]; then
    read -r -p "Certbot/ACME email for $domain: " email || true
  fi

  mkdir -p "$ETC_DIR"
  cat > "$STACKPORT_ENV_FILE" <<EOF
STACKPORT_DOMAIN=$domain
CERTBOT_EMAIL=$email

NODE_ENV=production
LOG_LEVEL=info
EOF
  chmod 640 "$STACKPORT_ENV_FILE"
  log "wrote $STACKPORT_ENV_FILE"
}

generate_secret_if_missing() {
  local key="$1"
  if ! grep -q "^${key}=" "$SECRETS_ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> "$SECRETS_ENV_FILE"
    log "generated $key"
  fi
}

# Sources secrets.env into the current shell (set -a so every KEY=value line is
# also exported, not just set) — lets a value written on one run (e.g.
# STACKPORT_REPO_TOKEN, saved by pull_stackport on first use) be picked up as a
# plain shell variable on a later run without re-parsing the file everywhere it's
# needed. Safe to source: this file only ever contains plain KEY=value lines this
# script itself writes.
load_secrets() {
  if [[ -f "$SECRETS_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$SECRETS_ENV_FILE"
    set +a
  fi
}

# Populates the global GIT_AUTH_ARGS array (bash has no clean way to return an
# array from a function) with a `-c http.extraHeader=...` git argument when
# STACKPORT_REPO_TOKEN is set, empty otherwise. GitHub (and most forges) stopped
# accepting a plain password for git-over-HTTPS, so a private repo needs *some*
# token even for a first, non-interactive clone — see pull_stackport. Uses an
# extra header rather than embedding the token in the URL so it never shows up in
# `git remote -v` or a `ps aux` listing of the running git command, matching the
# Basic-auth-over-header pattern src/services/projectDeploy.ts's gitAuthHeader()
# already uses for managed projects' own private-repo credentials.
git_auth_args() {
  GIT_AUTH_ARGS=()
  if [[ -n "${STACKPORT_REPO_TOKEN:-}" ]]; then
    GIT_AUTH_ARGS=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$STACKPORT_REPO_TOKEN" | base64 -w0)")
  fi
}

ensure_secrets() {
  mkdir -p "$ETC_DIR"
  chmod 700 "$ETC_DIR"
  touch "$SECRETS_ENV_FILE"
  chmod 600 "$SECRETS_ENV_FILE"

  generate_secret_if_missing "JWT_SECRET"
  generate_secret_if_missing "WEBHOOK_SECRET"

  # Bootstrap password: generated once, here, by bash — the app only ever consumes
  # it (services/installation.ts's ensureBootstrapCredential), it never invents or
  # reveals one itself. Matches stackport_host_lifecycle.md §5.1's own example
  # almost exactly (openssl rand | base32, ~80 bits). Skipped if already present
  # (idempotent — never regenerate a live bootstrap credential on rerun).
  if ! grep -q '^ADMIN_BOOTSTRAP_PASSWORD=' "$SECRETS_ENV_FILE" 2>/dev/null; then
    local bootstrap_password
    # Dash-grouped in 5-char blocks to match the format
    # services/installation.ts's generateSetupPassword() uses for recovery
    # credentials (cli/adminRecovery.ts) — same entropy, consistent look either way.
    bootstrap_password="$(openssl rand 10 | base32 | tr -d '=' | sed -E 's/.{5}/&-/g; s/-$//')"
    {
      echo "ADMIN_BOOTSTRAP_USERNAME=admin"
      echo "ADMIN_BOOTSTRAP_PASSWORD=$bootstrap_password"
    } >> "$SECRETS_ENV_FILE"
    echo ""
    echo "StackPort one-time bootstrap credential (expires in 24h):"
    echo ""
    echo "  Username: admin"
    echo "  Password: $bootstrap_password"
    echo ""
    echo "Log in and complete setup to create your real administrator account."
    echo ""
  fi
}

# ufw only — a DOCKER-USER-level defense-in-depth policy is explicitly deferred
# per stackport_host_lifecycle.md §13.1 (managed apps already can't publish host
# ports at all, so firewall rules aren't compensating for arbitrary app ports here).
ensure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    warn "ufw not found — skipping firewall configuration"
    return
  fi

  local ssh_port
  ssh_port="$(ss -tlnp 2>/dev/null | awk '/sshd/ {print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | head -n1)"
  ssh_port="${ssh_port:-22}"

  log "allowing SSH on port $ssh_port before enabling the firewall"
  ufw allow "$ssh_port"/tcp comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'HTTP' >/dev/null
  ufw allow 443/tcp comment 'HTTPS' >/dev/null
  ufw allow 8883/tcp comment 'MQTTS' >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  log "firewall enabled (SSH:$ssh_port, HTTP:80, HTTPS:443, MQTTS:8883 allowed; rest denied)"
}

ensure_cli() {
  local self
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  if [[ "$self" == "$CLI_TARGET" ]]; then
    return
  fi
  if [[ ! -r "$self" ]]; then
    warn "cannot install CLI to $CLI_TARGET (not run from a regular file) — save this script and rerun 'sudo ./stackport.sh install'"
    return
  fi
  install -m 0755 "$self" "$CLI_TARGET"
  log "installed management CLI to $CLI_TARGET"
}

pull_stackport() {
  local branch="${STACKPORT_BRANCH:-$STACKPORT_BRANCH_DEFAULT}"

  if [[ -d "$APP_DIR/.git" ]]; then
    log "updating existing checkout at $APP_DIR"
    git_auth_args
    GIT_TERMINAL_PROMPT=0 git "${GIT_AUTH_ARGS[@]}" -C "$APP_DIR" fetch --quiet origin "$branch"
    git -C "$APP_DIR" checkout --quiet "origin/$branch"
    return
  fi

  mkdir -p "$(dirname "$APP_DIR")"
  log "cloning $STACKPORT_REPO ($branch) into $APP_DIR"
  git_auth_args
  if GIT_TERMINAL_PROMPT=0 git "${GIT_AUTH_ARGS[@]}" clone --quiet --branch "$branch" "$STACKPORT_REPO" "$APP_DIR"; then
    return
  fi

  # A credential-less clone of a private repo fails exactly this way (GitHub and
  # most forges reject plain password auth for git-over-HTTPS outright) — prompt
  # once for a token and retry rather than treating that as fatal.
  if [[ -n "${STACKPORT_REPO_TOKEN:-}" || "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    error "failed to clone $STACKPORT_REPO"
    exit 1
  fi

  echo ""
  echo "Cloning $STACKPORT_REPO failed — it may be a private repository."
  read -r -s -p "GitHub personal access token (repo read access, blank to abort): " STACKPORT_REPO_TOKEN
  echo ""
  if [[ -z "$STACKPORT_REPO_TOKEN" ]]; then
    error "failed to clone $STACKPORT_REPO"
    exit 1
  fi

  git_auth_args
  if ! GIT_TERMINAL_PROMPT=0 git "${GIT_AUTH_ARGS[@]}" clone --quiet --branch "$branch" "$STACKPORT_REPO" "$APP_DIR"; then
    error "failed to clone $STACKPORT_REPO even with a token"
    exit 1
  fi

  # Persist for future `stackport update`/`repair` runs — same file/permissions
  # ensure_secrets already set up (chmod 600, dir chmod 700).
  printf 'STACKPORT_REPO_TOKEN=%s\n' "$STACKPORT_REPO_TOKEN" >> "$SECRETS_ENV_FILE"
  log "saved repository access token to $SECRETS_ENV_FILE for future updates"
}

# Regenerates the merged .env docker-compose.system.yml's stackport service reads
# (see that file's comment on why it's a bind-mounted plain file rather than
# env_file:). Source of truth stays split across stackport.env/secrets.env/host
# paths — this is a disposable, idempotently-regenerated artifact, safe to rerun
# any time either source file or the app checkout location changes.
ensure_env_file() {
  local target="$APP_DIR/.env"
  {
    echo "# Generated by stackport.sh — do not edit directly."
    echo "# Edit $STACKPORT_ENV_FILE / $SECRETS_ENV_FILE instead, then run: sudo stackport repair"
    echo ""
    cat "$STACKPORT_ENV_FILE" 2>/dev/null
    echo ""
    cat "$SECRETS_ENV_FILE" 2>/dev/null
    echo ""
    echo "HOST_PROJECT_ROOT=$APP_DIR"
    echo "STACKPORT_DATA_DIR=$VAR_DIR/data"
    echo "STACKPORT_LOGS_DIR=$VAR_DIR/logs"
    echo "STACKPORT_NGINX_DIR=$VAR_DIR/nginx"
  } > "$target"
  # This file is bind-mounted read-only into the stackport container and read by
  # its unprivileged `node` user (UID/GID 1000, the same assumption ensure_directories/
  # seed_nginx_data/repair_stackport already make elsewhere in this script) — not by
  # root. ensure_secrets's chmod 600 on $SECRETS_ENV_FILE is correctly root-only
  # (that file never leaves the host), but this *derived* file needs to be
  # owner-readable by that container user specifically, or the app fails to boot
  # with a cryptic "Missing required environment variable" several layers removed
  # from this actual cause. root (which is what runs this script) can always
  # read/write it regardless of this chown, so this doesn't weaken anything on the
  # host side — chmod 600 still means nobody *else* on the host can read it.
  chown "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$target"
  chmod 600 "$target"

  # Fail fast and clearly here rather than letting the app crash-loop on a
  # "Missing required environment variable" error several layers removed from
  # any useful context (env.ts's require_env) — these two are always required.
  local key
  for key in JWT_SECRET WEBHOOK_SECRET; do
    if ! grep -qE "^${key}=.+" "$target"; then
      error "generated $target has no value for $key — check $SECRETS_ENV_FILE, then rerun 'sudo stackport repair'"
      exit 1
    fi
  done
}

start_stackport() {
  # Without this, a genuinely fresh $VAR_DIR/nginx has no nginx.conf at all and
  # the nginx container crash-loops on its very first boot ("open() nginx.conf
  # failed") — this was previously only wired into repair_stackport, so a first
  # `install` never actually seeded it. seed_nginx_data is idempotent (no-ops if
  # nginx.conf already exists), so it's safe on every start, not just first boot.
  seed_nginx_data
  ensure_env_file
  log "building StackPort image"
  compose build
  log "starting StackPort"
  compose up -d --force-recreate
}

# ── install ───────────────────────────────────────────────────────────────────

ARG_DOMAIN=""
ARG_EMAIL=""
NONINTERACTIVE=0

parse_install_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain=*) ARG_DOMAIN="${1#*=}" ;;
      --email=*) ARG_EMAIL="${1#*=}" ;;
      --branch=*) STACKPORT_BRANCH="${1#*=}" ;;
      --yes) NONINTERACTIVE=1 ;;
      *) warn "unknown install option: $1" ;;
    esac
    shift
  done
}

# Database init, the one-time bootstrap credential, and the app's own HTTPS
# ingress (self-signed or Let's Encrypt) are all handled automatically by
# StackPort itself at boot (src/index.ts -> ensureBootstrapCredential() /
# ensureAppIngress()) once start_stackport brings the container up — no separate
# ensure_database/ensure_initial_bootstrap/ensure_certificate steps are needed
# here, unlike the generic skeleton in stackport_host_lifecycle.md §7.1.
install_stackport() {
  parse_install_args "$@"
  ensure_supported_os
  ensure_prerequisites
  ensure_docker
  ensure_directories
  ensure_configuration
  ensure_secrets
  load_secrets
  ensure_firewall
  pull_stackport
  ensure_cli
  start_stackport

  if healthcheck_stackport; then
    log "health check passed"
    log "waiting for first-login HTTPS (certificate issuance may take several minutes)"
    if ! healthcheck_ingress; then
      error "app is running, but HTTPS is not ready; check DNS, inbound ports 80/443, and docker logs stackport. Fix the cause and rerun install."
      exit 1
    fi
    state_set current "$(git -C "$APP_DIR" rev-parse HEAD)"
    state_set lastUpdate success
  else
    error "StackPort did not become healthy — check: docker logs stackport"
    exit 1
  fi

  log "install complete"
  status_stackport
}

# ── update / rollback ─────────────────────────────────────────────────────────

create_update_backup() {
  local from="$1" to="$2" ts dir
  ts="$(date -u +%Y%m%d-%H%M%S)"
  dir="$VAR_DIR/backups/update-${from:0:7}-${to:0:7}-${ts}"
  mkdir -p "$dir"

  log "backing up database before update"
  # -u node: the image has no default USER (docker-entrypoint.sh needs to start as
  # root to align the docker.sock group, then drops to node itself via gosu) — a
  # plain `docker exec` without -u would run as root and create .backup-tmp.sqlite
  # root-owned, which the app (running as node) couldn't clean up or reuse later.
  if ! docker exec -u node stackport node -e "
    const { initializeDatabase } = require('./dist/config/database');
    const db = initializeDatabase();
    db.exec(\"VACUUM INTO '/app/data/.backup-tmp.sqlite'\");
  "; then
    error "database backup failed"
    return 1
  fi
  docker cp "stackport:/app/data/.backup-tmp.sqlite" "$dir/stackport-db.sqlite"
  docker exec -u node stackport rm -f /app/data/.backup-tmp.sqlite

  cat > "$dir/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "stackport-update",
  "fromVersion": "$from",
  "toVersion": "$to"
}
EOF
  log "backup created at $dir"
}

update_stackport() {
  local branch="${STACKPORT_BRANCH:-$STACKPORT_BRANCH_DEFAULT}"
  local current target
  load_secrets
  current="$(git -C "$APP_DIR" rev-parse HEAD)"
  git_auth_args
  GIT_TERMINAL_PROMPT=0 git "${GIT_AUTH_ARGS[@]}" -C "$APP_DIR" fetch --quiet origin "$branch"
  target="$(git -C "$APP_DIR" rev-parse "origin/$branch")"

  if [[ "$current" == "$target" ]]; then
    log "already up to date (${current:0:7})"
    return 0
  fi

  log "updating StackPort: ${current:0:7} -> ${target:0:7}"
  # Fail closed — never touch the running install if the backup itself fails
  # (stackport_host_lifecycle.md §8.2).
  if ! create_update_backup "$current" "$target"; then
    error "update aborted — backup failed, StackPort left untouched"
    exit 1
  fi

  state_set previous "$current"
  git -C "$APP_DIR" checkout --quiet "$target"
  ensure_env_file
  compose up -d --build

  if healthcheck_stackport; then
    state_set current "$target"
    state_set lastUpdate success
    if [[ -f "$APP_DIR/stackport.sh" ]]; then install -m 0755 "$APP_DIR/stackport.sh" "$CLI_TARGET"; fi
    log "update complete"
  else
    error "health check failed after update — rolling back"
    state_set lastUpdate failed
    rollback_stackport
  fi
}

rollback_stackport() {
  local previous current
  previous="$(state_get previous)"
  if [[ -z "$previous" ]]; then
    error "no previous version recorded — nothing to roll back to"
    exit 1
  fi
  current="$(git -C "$APP_DIR" rev-parse HEAD)"
  log "rolling back StackPort: ${current:0:7} -> ${previous:0:7}"

  git -C "$APP_DIR" checkout --quiet "$previous"
  ensure_env_file
  compose up -d --build

  if healthcheck_stackport; then
    state_set current "$previous"
    state_set previous "$current"
    state_set lastUpdate rolled-back
    log "rollback complete"
  else
    error "StackPort is still unhealthy after rollback — manual intervention required (check: docker logs stackport)"
    exit 1
  fi
}

# ── status ────────────────────────────────────────────────────────────────────

# Once the operator has completed setup (the bootstrap credential is consumed —
# installation_initialized is true app-side), the plaintext ADMIN_BOOTSTRAP_* pair
# left in secrets.env no longer does anything except sit there — strip it for
# hygiene. Best-effort: silently no-ops if the app isn't reachable yet.
strip_bootstrap_secret_if_consumed() {
  grep -q '^ADMIN_BOOTSTRAP_PASSWORD=' "$SECRETS_ENV_FILE" 2>/dev/null || return 0
  local response
  response="$(curl -fsS "http://localhost:$(stackport_port)/api/setup/status" 2>/dev/null || true)"
  if [[ "$response" == *'"initialized":true'* ]]; then
    sed -i '/^ADMIN_BOOTSTRAP_USERNAME=/d;/^ADMIN_BOOTSTRAP_PASSWORD=/d' "$SECRETS_ENV_FILE"
    ensure_env_file
    log "removed consumed bootstrap credential from $SECRETS_ENV_FILE"
  fi
}

status_stackport() {
  echo "StackPort status"
  echo "----------------"
  if [[ -d "$APP_DIR/.git" ]]; then
    echo "version:      $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) (branch ${STACKPORT_BRANCH:-$STACKPORT_BRANCH_DEFAULT})"
  else
    echo "version:      not installed"
  fi
  echo "previous:     $(state_get previous || true)"
  echo "last update:  $(state_get lastUpdate || true)"
  echo
  echo "containers:"
  if command -v docker >/dev/null 2>&1; then
    docker ps --filter "label=com.docker.compose.project=stackport" --format '  {{.Names}}: {{.Status}}' || true
  else
    echo "  docker not available"
  fi
  echo
  if healthcheck_stackport 1; then
    echo "health:       ok"
  else
    echo "health:       unreachable"
  fi
  echo "network:      $(docker network inspect stackport-proxy >/dev/null 2>&1 && echo present || echo missing)"
  echo "letsencrypt:  $([[ -d /etc/letsencrypt/live ]] && echo "$(find /etc/letsencrypt/live -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l) domain(s)" || echo none)"
  echo "directories:  $([[ -d "$ETC_DIR" && -d "$VAR_DIR" ]] && echo ok || echo missing)"
  if command -v ufw >/dev/null 2>&1; then
    echo "firewall:     $(ufw status 2>/dev/null | head -1)"
  fi

  strip_bootstrap_secret_if_consumed || true
}

# ── repair ────────────────────────────────────────────────────────────────────

# Rebuild of the exact nginx-data scaffold (nginx.conf, mime.types,
# sites-available/sites-enabled + the default symlink) that this session's own
# earlier install needed hand-seeding for — closes that gap by making it a
# repeatable function instead of a one-off manual step.
seed_nginx_data() {
  local dir="$VAR_DIR/nginx"
  if [[ -f "$dir/nginx.conf" ]]; then
    return 0
  fi
  log "seeding nginx-data scaffold at $dir"
  mkdir -p "$dir/sites-available" "$dir/sites-enabled"
  cat > "$dir/nginx.conf" <<'EOF'
user nginx;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;

    include /etc/nginx/sites-enabled/*;
}
EOF
  # mime.types ships inside the official nginx image — copy it out once rather than
  # hand-maintaining a duplicate that could drift from what the serving image expects.
  docker run --rm nginx:1.27-alpine cat /etc/nginx/mime.types > "$dir/mime.types" 2>/dev/null || true
  touch "$dir/sites-available/default"
  ln -sf ../sites-available/default "$dir/sites-enabled/default"
  chown -R "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$dir" 2>/dev/null || true
}

repair_stackport() {
  log "checking Docker"
  docker version >/dev/null 2>&1 || { error "Docker is not available"; exit 1; }

  log "checking stackport-proxy network"
  docker network inspect stackport-proxy >/dev/null 2>&1 || docker network create stackport-proxy >/dev/null

  seed_nginx_data

  log "checking directory ownership"
  chown -R "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$VAR_DIR/data" "$VAR_DIR/logs" "$VAR_DIR/nginx" 2>/dev/null || true

  if [[ -f "$COMPOSE_FILE" ]]; then
    ensure_env_file
    log "validating compose configuration"
    compose config >/dev/null

    for name in stackport stackport-nginx; do
      if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
        log "starting missing container: $name"
        if [[ "$name" == "stackport-nginx" ]]; then compose up -d nginx; else compose up -d stackport; fi
      fi
    done
  fi

  strip_bootstrap_secret_if_consumed || true
  log "repair complete"
}

# ── admin-recovery ────────────────────────────────────────────────────────────

admin_recovery() {
  require_root
  require_interactive_tty

  if ! docker ps --format '{{.Names}}' | grep -qx stackport; then
    error "stackport container is not running"
    exit 1
  fi

  echo "This generates a temporary credential that allows resetting"
  echo "StackPort's administrator password. It does not touch project"
  echo "data or existing project deployments."
  read -r -p "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    log "cancelled"
    exit 0
  fi

  # docker exec on the docker.sock *is* the local-root authorization boundary here
  # (stackport_host_lifecycle.md §6.1) — there is deliberately no HTTP endpoint that
  # generates a recovery credential (src/cli/adminRecovery.ts's own header comment).
  # -u node: match the app's own runtime user (see create_update_backup's comment).
  docker exec -i -u node stackport node dist/cli/adminRecovery.js
}

# ── uninstall ─────────────────────────────────────────────────────────────────

uninstall_stackport() {
  local purge="${1:-}"

  if [[ "$purge" == "--purge" ]]; then
    require_interactive_tty
    echo "This permanently deletes StackPort state, users,"
    echo "secrets, configuration and backups."
    echo
    read -r -p "Type DELETE STACKPORT to continue: " confirm
    if [[ "$confirm" != "DELETE STACKPORT" ]]; then
      log "cancelled"
      exit 0
    fi
  fi

  if [[ -f "$COMPOSE_FILE" ]]; then
    log "stopping and removing StackPort containers"
    compose down --remove-orphans || true
  fi
  docker network rm stackport-proxy >/dev/null 2>&1 || true

  if [[ "$purge" == "--purge" ]]; then
    log "removing $ETC_DIR and $VAR_DIR"
    rm -rf "$ETC_DIR" "$VAR_DIR"
    # The self-signed bootstrap cert (src/services/nginx/selfSignedCert.ts) lives
    # under /etc/letsencrypt rather than $VAR_DIR, so the line above misses it. Only
    # this StackPort-owned subdirectory goes — /etc/letsencrypt itself is left alone,
    # since real Let's Encrypt certs there stay usable by any host-native certbot.
    rm -rf /etc/letsencrypt/stackport-selfsigned
    rm -f "$CLI_TARGET"
    log "StackPort purged"
  else
    log "StackPort runtime removed. Persistent state preserved under $ETC_DIR and $VAR_DIR."
    log "Run 'stackport install' to reinstall using the existing configuration/data."
  fi
}

# ── dispatch ──────────────────────────────────────────────────────────────────
# Guarded so this file can be `source`d (e.g. to call individual functions
# directly against a scratch ETC_DIR/VAR_DIR for testing) without also running
# the dispatch below and potentially `exit`ing the sourcing shell.

if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift

case "$COMMAND" in
  install)
    require_root
    install_stackport "$@"
    ;;
  update)
    require_root
    update_stackport
    ;;
  rollback)
    require_root
    rollback_stackport
    ;;
  status)
    status_stackport
    ;;
  repair)
    require_root
    repair_stackport
    ;;
  admin-recovery)
    admin_recovery
    ;;
  uninstall)
    require_root
    uninstall_stackport "${1:-}"
    ;;
  help|-h|--help)
    usage
    ;;
  "")
    usage
    exit 1
    ;;
  *)
    error "unknown command: $COMMAND"
    usage
    exit 1
    ;;
esac

fi
