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

# Real StackPort source location — overridable for testing via env, but this is what
# a fresh `install` clones by default. The branch comes from configured_branch.
STACKPORT_REPO="${STACKPORT_REPO:-https://github.com/vtmattedi/Stackport.git}"

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
                    (--branch defaults to stable and is remembered for updates)
  stackport update
  stackport rollback
  stackport status
  stackport selfcheck
  stackport repair
  stackport reboot [--in <minutes>] [--yes]
  stackport network-pool [show | set --base <cidr> --size <n> [--replace] [--no-restart] [--yes]]
  stackport admin-recovery
  stackport backup [--level 1|2] [--out FILE]
  stackport backup-verify FILE
  stackport restore FILE --mode recover|clone [--yes]
  stackport uninstall
  stackport uninstall --purge

install:  set up or reconcile a StackPort installation (idempotent).
update:   build the new version aside, swap to it, and roll back automatically
          unless it serves its UI and can launch the next update. Never
          touches managed projects.
rollback: revert StackPort itself to the previous known-good version.
selfcheck: verify this script and its host dependencies (read-only).
status:   non-mutating inspection of the current installation.
repair:   reconcile StackPort-owned infrastructure (network, nginx scaffold,
          directory permissions) without touching admin/secrets/certs/project data.
reboot:   schedule a reboot of this machine (now, or in a number of minutes, up
          to 60) after listing the containers that will not come back by
          themselves. Host > Power in the UI asks for the same thing through a
          signed request file and a systemd path unit that install and repair set up.
network-pool: show Docker's address pools, or enlarge them. `set` writes
          default-address-pools into /etc/docker/daemon.json after checking the
          range against this host's routes, keeps a backup, restarts Docker
          unless --no-restart (which stops every container unless live-restore is
          on), and puts the old file back if Docker does not come up. The default
          is 10.20.0.0/14 in /24 slices: 1024 networks. Existing networks keep
          their ranges. Pools already in daemon.json are replaced only with --replace.
admin-recovery: root+interactive only — generates a temporary credential to reset
          StackPort's administrator password.
backup:   write a passphrase-encrypted, portable archive. Level 1: instance settings,
          administrator identity (password hash), credentials, integrations and the
          keys that decrypt them. Level 2 (default): also every project's record,
          Compose files, managed .env files (with their secret values), domains,
          routes and uploaded files. It does NOT contain application data
          (databases, volumes, user files) and cannot recover it.
backup-verify: authenticate and check an archive (checksums, schema, that every stored
          secret decrypts with the archive's keys) without changing anything.
restore:  replace this installation's configuration with an archive's. --mode recover
          keeps the instance identity (a lost or moved host); --mode clone creates a
          new identity, ends sessions, removes API tokens and the GitHub App, pauses
          projects and turns automation off. Stops Stackport while it runs, keeps the
          previous database and secrets under /var/lib/stackport, and works with the
          web UI unavailable.
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

# Servers follow `stable`, which CI fast-forwards only after the upgrade scenarios
# pass on a commit. `install --branch=<name>` saves another branch in stackport.env;
# STACKPORT_BRANCH in the environment overrides both for one run.
configured_branch() {
  local saved
  saved="$(grep -m1 '^STACKPORT_BRANCH=' "$STACKPORT_ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  echo "${STACKPORT_BRANCH:-${saved:-stable}}"
}

save_branch() {
  local branch="$1"
  if grep -q '^STACKPORT_BRANCH=' "$STACKPORT_ENV_FILE" 2>/dev/null; then
    sed -i "s|^STACKPORT_BRANCH=.*|STACKPORT_BRANCH=${branch}|" "$STACKPORT_ENV_FILE"
  else
    echo "STACKPORT_BRANCH=${branch}" >> "$STACKPORT_ENV_FILE"
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
  local attempts="${STACKPORT_INGRESS_ATTEMPTS:-180}" domain i
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
  else
    log "installing Docker"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  ensure_buildx
}

require_buildx() {
  docker buildx version >/dev/null 2>&1 && return 0
  error "Docker Buildx is missing or unusable; StackPort builds require 'docker buildx version' to succeed."
  error "On Ubuntu/Debian with Docker's official apt repository configured, run: sudo apt-get update && sudo apt-get install -y docker-buildx-plugin"
  error "For other installations, install or repair the Buildx CLI plugin: https://docs.docker.com/build/buildx/"
  error "Verify with 'sudo docker buildx version', then retry the StackPort command. The running StackPort image has not been changed."
  return 1
}

docker_official_apt_available() {
  local ID=""
  [[ -f /etc/os-release ]] || return 1
  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) return 1 ;; esac
  command -v apt-get >/dev/null 2>&1 && command -v apt-cache >/dev/null 2>&1 || return 1
  # A configured repository may have no cached indexes yet (e.g. a minimal host).
  log "refreshing apt metadata to check for Docker's official repository"
  apt-get update || return 1
  # Inspect apt's active indexes, so a similarly named distro package is not
  # mistaken for Docker's plugin. Works with both .list and deb822 .sources.
  apt-cache policy 2>/dev/null | grep -E 'https?://download\.docker\.com/linux/(ubuntu|debian)(/|[[:space:]])' >/dev/null
}

ensure_buildx() {
  docker buildx version >/dev/null 2>&1 && return 0
  if docker_official_apt_available; then
    log "installing Docker Buildx from Docker's official apt repository"
    if ! apt-get install -y --no-install-recommends docker-buildx-plugin; then
      warn "could not install docker-buildx-plugin"
    fi
  fi
  require_buildx
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
  # src/modules/ingress/nginx/configWriter.ts — must stay in sync with that constant.
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
# Basic-auth-over-header pattern src/modules/deployments/operations.ts's gitAuthHeader()
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
  # Encrypts stored credentials and tokens, separate from JWT_SECRET so rotating the
  # session secret cannot break them. Back up secrets.env: without this key they are lost.
  generate_secret_if_missing "ENCRYPTION_KEY"
  # Signs the reboot requests Host > Power writes; this script refuses any request that is not signed with it (see power_verify).
  generate_secret_if_missing "STACKPORT_POWER_KEY"

  # Bootstrap password: generated once, here, by bash — the app only ever consumes
  # it (modules/identity/installation.ts's ensureBootstrapCredential), it never invents or
  # reveals one itself. Matches stackport_host_lifecycle.md §5.1's own example
  # almost exactly (openssl rand | base32, ~80 bits). Skipped if already present
  # (idempotent — never regenerate a live bootstrap credential on rerun).
  if ! grep -q '^ADMIN_BOOTSTRAP_PASSWORD=' "$SECRETS_ENV_FILE" 2>/dev/null; then
    local bootstrap_password
    # Dash-grouped in 5-char blocks to match the format
    # modules/identity/installation.ts's generateSetupPassword() uses for recovery
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
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  log "firewall enabled (SSH:$ssh_port, HTTP:80, HTTPS:443 allowed; rest denied)"
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
  local branch
  branch="$(configured_branch)"

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
    echo "STACKPORT_POWER_DIR=$POWER_STATE_DIR"
    echo "STACKPORT_NGINX_DIR=$VAR_DIR/nginx"
    # The app's update check: which branch, which repository, and what is running.
    echo "GIT_BRANCH=$(configured_branch)"
    echo "STACKPORT_REPO_URL=$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
    echo "STACKPORT_COMMIT=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
    # Mounted read-only for free-disk checks; only written when Docker's data root
    # was moved (docker-compose.system.yml defaults to /var/lib/docker).
    local docker_root
    docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    if [[ -n "$docker_root" && "$docker_root" != "/var/lib/docker" ]]; then
      echo "STACKPORT_DOCKER_ROOT=$docker_root"
    fi
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
  DOCKER_BUILDKIT=1 compose build
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
  if [[ -n "${STACKPORT_BRANCH:-}" ]]; then save_branch "$STACKPORT_BRANCH"; fi
  ensure_secrets
  load_secrets
  ensure_firewall
  pull_stackport
  ensure_cli
  ensure_power_units
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

# Compose tags the stackport service's image with this name (docker-compose.system.yml
# sets it explicitly), so swapping versions is a retag plus a recreate, not a rebuild.
APP_IMAGE="stackport-stackport:latest"
PREVIOUS_IMAGE="stackport:previous"
STAGING_DIR="$VAR_DIR/update/staging"
STAGED_IMAGE=""

running_image_id() {
  docker inspect --format '{{.Image}}' stackport 2>/dev/null || true
}

cleanup_staging() {
  if [[ -d "$STAGING_DIR" ]]; then
    git -C "$APP_DIR" worktree remove --force "$STAGING_DIR" 2>/dev/null || rm -rf "$STAGING_DIR"
  fi
  git -C "$APP_DIR" worktree prune 2>/dev/null || true
}

wait_for_url() {
  local url="$1" attempts="${2:-30}" i
  for ((i = 0; i < attempts; i++)); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

# Everything that can fail without network-free recovery happens here, before the
# running install is touched: the target's CLI must parse and pass its own selfcheck,
# and its image must build. A failure leaves HEAD and the running container as they
# were, so the next `stackport update` retries instead of saying "already up to date".
stage_update() {
  local target="$1"
  require_buildx || return 1
  cleanup_staging
  mkdir -p "$(dirname "$STAGING_DIR")"
  git -C "$APP_DIR" worktree add --force --detach --quiet "$STAGING_DIR" "$target" || return 1

  log "checking the new version's CLI"
  if [[ ! -f "$STAGING_DIR/stackport.sh" ]]; then
    error "target ${target:0:7} has no stackport.sh"
    return 1
  fi
  bash -n "$STAGING_DIR/stackport.sh" || { error "new stackport.sh has a syntax error"; return 1; }
  ETC_DIR="$ETC_DIR" VAR_DIR="$VAR_DIR" APP_DIR="$APP_DIR" bash "$STAGING_DIR/stackport.sh" selfcheck \
    || { error "new stackport.sh failed its selfcheck"; return 1; }

  log "building image for ${target:0:7}"
  DOCKER_BUILDKIT=1 docker build --quiet --build-arg "STACKPORT_COMMIT=$target" --tag "stackport:${target:0:12}" "$STAGING_DIR" >/dev/null \
    || { error "image build failed for ${target:0:7}"; return 1; }
  STAGED_IMAGE="stackport:${target:0:12}"
}

swap_to_image() {
  local image="$1"
  docker tag "$image" "$APP_IMAGE" || return 1
  ensure_env_file
  compose up -d --no-build --force-recreate stackport || return 1
  compose up -d --no-build || return 1
}

# Health alone only proves Express is listening. A version is accepted only if it
# serves its UI, reports ready (database, bundle, Docker) and can still launch the
# updater from its own image — i.e. it can be updated again to fix whatever is wrong.
verify_running_version() {
  local base asset
  base="http://localhost:$(stackport_port)"
  healthcheck_stackport || { error "/health did not respond"; return 1; }
  wait_for_url "$base/health/ready" 15 || { error "/health/ready did not report ready"; return 1; }
  asset="$(curl -fsS "$base/" 2>/dev/null | grep -o '/assets/[^"]*\.js' | head -1 || true)"
  if [[ -z "$asset" ]] || ! curl -fsS -o /dev/null "$base$asset"; then
    error "the web UI is not being served"
    return 1
  fi
  docker exec -u node stackport node dist/scripts/updaterSelfTest.js \
    || { error "the new version cannot launch the updater"; return 1; }
}

prune_staged_images() {
  local keep="$1" image
  while read -r image; do
    [[ "$image" == "$keep" || "$image" == "$PREVIOUS_IMAGE" ]] && continue
    docker rmi "$image" >/dev/null 2>&1 || true
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' stackport 2>/dev/null)
}

update_stackport() {
  local branch current target
  branch="$(configured_branch)"
  load_secrets
  current="$(git -C "$APP_DIR" rev-parse HEAD)"
  git_auth_args
  if ! GIT_TERMINAL_PROMPT=0 git "${GIT_AUTH_ARGS[@]}" -C "$APP_DIR" fetch --quiet origin "$branch" 2>/dev/null; then
    # Until CI has promoted a first commit, the repository has no stable branch.
    if [[ "$branch" == stable ]] && GIT_TERMINAL_PROMPT=0 git "${GIT_AUTH_ARGS[@]}" -C "$APP_DIR" fetch --quiet origin main; then
      warn "origin has no stable branch yet — following main"
      branch=main
    else
      error "cannot fetch origin/$branch"
      exit 1
    fi
  fi
  target="$(git -C "$APP_DIR" rev-parse "origin/$branch")"

  if [[ "$current" == "$target" ]]; then
    log "already up to date (${current:0:7})"
    return 0
  fi
  # Never step backwards, e.g. a server installed from main while stable catches up.
  if git -C "$APP_DIR" merge-base --is-ancestor "$target" "$current"; then
    log "already up to date (${current:0:7} is ahead of origin/$branch)"
    return 0
  fi

  log "updating StackPort: ${current:0:7} -> ${target:0:7}"
  print_network_headroom
  if ! stage_update "$target"; then
    cleanup_staging
    state_set lastUpdate failed
    error "update aborted before anything changed — StackPort is still on ${current:0:7}"
    exit 1
  fi

  # Fail closed — never touch the running install if the backup itself fails
  # (stackport_host_lifecycle.md §8.2).
  if ! create_update_backup "$current" "$target"; then
    cleanup_staging
    error "update aborted — backup failed, StackPort left untouched"
    exit 1
  fi

  # Keep the running image under a fixed tag so rollback needs no rebuild or network.
  local running
  running="$(running_image_id)"
  if [[ -n "$running" ]]; then docker tag "$running" "$PREVIOUS_IMAGE"; fi
  state_set previous "$current"
  git -C "$APP_DIR" checkout --quiet "$target"

  if swap_to_image "$STAGED_IMAGE" && verify_running_version; then
    state_set current "$target"
    state_set lastUpdate success
    install -m 0755 "$APP_DIR/stackport.sh" "$CLI_TARGET"
    ensure_power_units || true
    cleanup_staging
    prune_staged_images "$STAGED_IMAGE"
    log "update complete"
  else
    error "new version failed verification — rolling back"
    state_set lastUpdate failed
    cleanup_staging
    rollback_stackport
  fi
}

# Restores the database snapshot taken by the update from $from to $to. Only used when
# the previous version can't start on the current database, e.g. after a migration.
restore_update_backup() {
  local from="$1" to="$2" dir
  dir="$(find "$VAR_DIR/backups" -maxdepth 1 -type d -name "update-${from:0:7}-${to:0:7}-*" 2>/dev/null | sort | tail -1)"
  if [[ -z "$dir" || ! -f "$dir/stackport-db.sqlite" ]]; then
    error "no database backup found for ${from:0:7} -> ${to:0:7}"
    return 1
  fi
  warn "restoring database from $dir — changes made since the update are lost"
  compose stop stackport || true
  cp "$dir/stackport-db.sqlite" "$VAR_DIR/data/stackport.sqlite"
  rm -f "$VAR_DIR/data/stackport.sqlite-wal" "$VAR_DIR/data/stackport.sqlite-shm"
  chown "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$VAR_DIR/data/stackport.sqlite"
  compose up -d --no-build stackport
}

rollback_stackport() {
  local previous current rolled_from
  previous="$(state_get previous)"
  if [[ -z "$previous" ]]; then
    error "no previous version recorded — nothing to roll back to"
    exit 1
  fi
  current="$(git -C "$APP_DIR" rev-parse HEAD)"
  rolled_from="$(running_image_id)"
  log "rolling back StackPort: ${current:0:7} -> ${previous:0:7}"

  git -C "$APP_DIR" checkout --quiet "$previous"
  if docker image inspect "$PREVIOUS_IMAGE" >/dev/null 2>&1; then
    swap_to_image "$PREVIOUS_IMAGE" || true
  else
    warn "no saved image for ${previous:0:7} — rebuilding it"
    ensure_env_file
    DOCKER_BUILDKIT=1 compose up -d --build || true
  fi

  if ! healthcheck_stackport; then
    restore_update_backup "$previous" "$current" || true
  fi

  if healthcheck_stackport; then
    if [[ -n "$rolled_from" ]]; then docker tag "$rolled_from" "$PREVIOUS_IMAGE"; fi
    state_set current "$previous"
    state_set previous "$current"
    state_set lastUpdate rolled-back
    install -m 0755 "$APP_DIR/stackport.sh" "$CLI_TARGET"
    log "rollback complete"
  else
    error "StackPort is still unhealthy after rollback — manual intervention required (check: docker logs stackport)"
    exit 1
  fi
}

# Run by the *previous* version's update against this version's script before it is
# installed: proves the file loads, its dependencies exist and the commands the next
# update relies on are defined. Read-only; needs no root.
selfcheck_stackport() {
  local tool fn failed=0
  for tool in git docker curl; do
    command -v "$tool" >/dev/null 2>&1 || { error "selfcheck: $tool not found"; failed=1; }
  done
  docker compose version >/dev/null 2>&1 || { error "selfcheck: docker compose not available"; failed=1; }
  require_buildx || failed=1
  for fn in update_stackport rollback_stackport stage_update verify_running_version create_update_backup; do
    declare -F "$fn" >/dev/null || { error "selfcheck: $fn is not defined"; failed=1; }
  done
  [[ "$failed" == 0 ]] || return 1
  log "selfcheck passed"
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

# ── network headroom (P3) ─────────────────────────────────────────────────────

# Docker gives every network a slice of an address pool, and a new network fails once it is
# used up (the 1.3.0 incident). Prints "<used> <capacity> <known>" where known is "daemon" when
# the pools were read from the daemon and "stock" when Docker's defaults (31 slices) are assumed.
# Counts bridge networks, so a network with a range of its own is counted too: it can only
# overstate the use. The application computes the exact figure (src/modules/maintenance/networkHeadroom.ts).
network_headroom() {
  command -v docker >/dev/null 2>&1 || return 1
  local pools capacity=0 known=daemon base size prefix used
  pools="$(docker info --format '{{range .DefaultAddressPools}}{{.Base}} {{.Size}}{{"\n"}}{{end}}' 2>/dev/null)" || return 1
  if [[ -z "${pools//[[:space:]]/}" ]]; then
    capacity=31
    known=stock
  else
    while read -r base size; do
      [[ -n "$base" && -n "$size" ]] || continue
      prefix="${base##*/}"
      if (( size >= prefix )); then capacity=$(( capacity + (1 << (size - prefix)) )); fi
    done <<< "$pools"
  fi
  used="$(docker network ls --filter driver=bridge --quiet 2>/dev/null | wc -l | tr -d '[:space:]')"
  echo "$used $capacity $known"
}

# One line for `status`; warns when 6 or fewer remain (critical at 2), the same thresholds as the application.
print_network_headroom() {
  local used capacity known free
  read -r used capacity known < <(network_headroom) || { echo "networks:     unknown (docker not readable)"; return 0; }
  free=$(( capacity - used ))
  if (( free < 0 )); then free=0; fi
  echo "networks:     $used of $capacity address-pool slices used, $free free$([[ "$known" == stock ]] && echo " (Docker's default pools)")"
  if (( free <= 6 )); then
    warn "Docker has room for only $free more networks. Enlarge the pool: sudo stackport network-pool set --base 10.20.0.0/14 --size 24 (it checks the range against this host first and asks before restarting Docker); or edit /etc/docker/daemon.json by hand: {\"default-address-pools\":[{\"base\":\"10.20.0.0/14\",\"size\":24}]}, then restart Docker."
  fi
}

status_stackport() {
  echo "StackPort status"
  echo "----------------"
  if [[ -d "$APP_DIR/.git" ]]; then
    echo "version:      $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) (branch $(configured_branch))"
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
  print_network_headroom
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

  # A release that adds the reboot request needs its key and its systemd units on a host installed before it: this is where they arrive.
  local new_power_key=0
  if [[ -f "$SECRETS_ENV_FILE" ]] && ! grep -q '^STACKPORT_POWER_KEY=' "$SECRETS_ENV_FILE"; then
    generate_secret_if_missing "STACKPORT_POWER_KEY"
    new_power_key=1
  fi
  # The app also needs the read-only mount of $POWER_STATE_DIR, which a container made by an older release does not have.
  if [[ "$(docker inspect stackport --format '{{range .Mounts}}{{if eq .Destination "/app/power-state"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)" != "$POWER_STATE_DIR" ]]; then new_power_key=1; fi
  ensure_power_units

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
  if (( new_power_key == 1 )) && [[ -f "$COMPOSE_FILE" ]] && docker ps --format '{{.Names}}' | grep -qx stackport; then
    log "recreating stackport so it gets the power key and the power state mount"
    compose up -d --force-recreate stackport >/dev/null
  fi
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

# ── backup / restore ──────────────────────────────────────────────────────────
# Portable backup of this installation (levels 1 and 2; docs/roadmap/1.4.md). The archive is
# built and read by dist/cli/backup.js inside the app image: it can see the database, the
# merged environment and the data directory, which is all a level 1 or 2 archive holds.
# Restore is offline: it stops the app, runs the same code in a one-off container, then adopts
# the archive's encryption keys into secrets.env (the app cannot write there). Nothing here
# is reachable over HTTP; root on the host is the authorization boundary.

BACKUP_CLI="dist/cli/backup.js"
STAGED_HOST_FILE=""
STAGED_CONTAINER_FILE=""

# Reads the archive passphrase without echo into STACKPORT_BACKUP_PASSPHRASE (exported so docker
# can pass it by name: it never appears in a process list). A value already in the environment wins.
backup_passphrase() {
  local mode="${1:-}" first second
  [[ -n "${STACKPORT_BACKUP_PASSPHRASE:-}" ]] && return 0
  [[ -t 0 ]] || { error "no passphrase: set STACKPORT_BACKUP_PASSPHRASE or run on a terminal"; exit 1; }
  read -r -s -p "Backup passphrase: " first; echo
  if [[ "$mode" == "confirm" ]]; then
    (( ${#first} >= 12 )) || { error "use a passphrase of at least 12 characters"; exit 1; }
    read -r -s -p "Repeat the passphrase: " second; echo
    [[ "$first" == "$second" ]] || { error "the passphrases differ"; exit 1; }
  fi
  [[ -n "$first" ]] || { error "the passphrase is empty"; exit 1; }
  export STACKPORT_BACKUP_PASSPHRASE="$first"
}

# Makes an archive readable inside the container, which only sees $VAR_DIR/data. Sets
# STAGED_CONTAINER_FILE, and STAGED_HOST_FILE when a copy was made (remove it afterwards).
stage_backup_file() {
  local src data="$VAR_DIR/data"
  [[ -f "${1:-}" ]] || { error "no such file: ${1:-<none>}"; exit 1; }
  src="$(readlink -f "$1")"
  STAGED_HOST_FILE=""
  if [[ "$src" == "$data/"* ]]; then
    STAGED_CONTAINER_FILE="/app/data/${src#"$data/"}"
    return 0
  fi
  mkdir -p "$data/backups"
  STAGED_HOST_FILE="$data/backups/.import-$$-$(basename "$src")"
  # The copy holds every secret in the archive: remove it on any exit, including errors and Ctrl-C.
  trap 'drop_staged_file' EXIT
  trap 'exit 130' INT TERM
  cp "$src" "$STAGED_HOST_FILE"
  chown "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$STAGED_HOST_FILE"
  chmod 600 "$STAGED_HOST_FILE"
  STAGED_CONTAINER_FILE="/app/data/backups/${STAGED_HOST_FILE##*/}"
}

drop_staged_file() {
  [[ -z "$STAGED_HOST_FILE" ]] || rm -f "$STAGED_HOST_FILE"
}

backup_stackport() {
  local level=2 out="" arg name made
  while (( $# )); do
    arg="$1"
    case "$arg" in
      --level=*) level="${arg#--level=}"; shift ;;
      --level)   (( $# >= 2 )) || { error "--level needs a value"; exit 1; }; level="$2"; shift 2 ;;
      --out=*)   out="${arg#--out=}"; shift ;;
      --out)     (( $# >= 2 )) || { error "--out needs a value"; exit 1; }; out="$2"; shift 2 ;;
      *) error "unknown option: $arg"; exit 1 ;;
    esac
  done
  [[ "$level" == "1" || "$level" == "2" ]] || { error "--level must be 1 (configs) or 2 (configs + project configs); level 3 is not available yet"; exit 1; }
  docker ps --format '{{.Names}}' | grep -qx stackport || { error "the stackport container is not running"; exit 1; }
  if [[ -n "$out" && -e "$out" ]]; then error "$out already exists"; exit 1; fi

  name="stackport-backup-l${level}-$(date -u +%Y%m%d-%H%M%S).spbackup"
  mkdir -p "$VAR_DIR/data/backups"
  chown "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$VAR_DIR/data/backups" 2>/dev/null || true
  backup_passphrase confirm
  docker exec -u node -e STACKPORT_BACKUP_PASSPHRASE stackport node "$BACKUP_CLI" create --level "$level" --out "/app/data/backups/$name"
  made="$VAR_DIR/data/backups/$name"
  chmod 600 "$made"
  if [[ -n "$out" ]]; then
    mv "$made" "$out"
    chmod 600 "$out"
    log "backup written to $out"
  else
    log "backup written to $made"
  fi
  log "copy it off this host: a backup stored only here does not survive losing the host."
}

backup_verify_stackport() {
  local rc=0
  docker ps --format '{{.Names}}' | grep -qx stackport || { error "the stackport container is not running"; exit 1; }
  stage_backup_file "${1:-}"
  backup_passphrase
  docker exec -u node -e STACKPORT_BACKUP_PASSPHRASE stackport node "$BACKUP_CLI" verify "$STAGED_CONTAINER_FILE" || rc=$?
  drop_staged_file
  return "$rc"
}

# Replaces KEY in secrets.env with the archive's value, appending it when absent. The Node side
# only hands over values made of [A-Za-z0-9._=+,-], so they are safe in a sed replacement.
adopt_secret() {
  local key="$1" value="$2" file="${3:-$SECRETS_ENV_FILE}"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Merges the handoff file's keys into a copy of secrets.env and moves the copy into place in one
# step, so a failure part-way leaves the original file untouched. Returns non-zero on any failure.
merge_restore_secrets() {
  local handoff="$1" merged key line
  merged="$(mktemp "${SECRETS_ENV_FILE}.restore.XXXXXX")" || return 1
  if [[ -f "$SECRETS_ENV_FILE" ]]; then cp -p "$SECRETS_ENV_FILE" "$merged" || { rm -f "$merged"; return 1; }; fi
  for key in JWT_SECRET ENCRYPTION_KEY ENCRYPTION_KEY_PREVIOUS WEBHOOK_SECRET; do
    line="$(grep "^${key}=" "$handoff" || true)"
    if [[ -n "$line" ]]; then
      adopt_secret "$key" "${line#*=}" "$merged" || { rm -f "$merged"; return 1; }
    elif grep -q "^${key}=" "$merged" 2>/dev/null; then
      # The archive had no such key: keeping the host's would change how new secrets are written.
      sed -i "/^${key}=/d" "$merged" || { rm -f "$merged"; return 1; }
    fi
  done
  mv "$merged" "$SECRETS_ENV_FILE" || { rm -f "$merged"; return 1; }
}

restore_stackport() {
  local file="" mode="" yes=0 arg confirm stamp keep rc=0 handoff verify_out verify_rc no_admin=0
  while (( $# )); do
    arg="$1"
    case "$arg" in
      --mode=*) mode="${arg#--mode=}"; shift ;;
      --mode)   (( $# >= 2 )) || { error "--mode needs a value"; exit 1; }; mode="$2"; shift 2 ;;
      --yes)    yes=1; shift ;;
      -*)       error "unknown option: $arg"; exit 1 ;;
      *)        file="$arg"; shift ;;
    esac
  done
  [[ -n "$file" ]] || { error "usage: stackport restore FILE --mode recover|clone [--yes]"; exit 1; }
  [[ "$mode" == "recover" || "$mode" == "clone" ]] || { error "--mode recover|clone is required: recover keeps this instance's identity (a lost or moved host); clone creates a new identity"; exit 1; }
  [[ -f "$COMPOSE_FILE" ]] || { error "no installation found at $APP_DIR: run 'stackport install' first"; exit 1; }

  stage_backup_file "$file"
  backup_passphrase

  # Everything that can be checked without touching the installation is checked first, in the running container.
  if docker ps --format '{{.Names}}' | grep -qx stackport; then
    log "verifying the archive"
    verify_rc=0
    verify_out="$(docker exec -u node -e STACKPORT_BACKUP_PASSPHRASE stackport node "$BACKUP_CLI" verify "$STAGED_CONTAINER_FILE" 2>&1)" || verify_rc=$?
    printf '%s\n' "$verify_out"
    if (( verify_rc != 0 )); then
      drop_staged_file
      error "the archive did not verify; nothing was changed"
      exit 1
    fi
    [[ "$verify_out" != *"no administrator password hash"* ]] || no_admin=1
  fi

  echo
  echo "Restoring REPLACES this installation's configuration with the archive's (mode: $mode)."
  echo "The current database, replaced directories and secrets.env are kept under $VAR_DIR."
  echo "Stackport is stopped while this runs. Applications keep running."
  if (( yes == 0 )); then
    require_interactive_tty
    read -r -p "Type RESTORE to continue: " confirm
    if [[ "$confirm" != "RESTORE" ]]; then
      drop_staged_file
      log "cancelled"
      exit 1
    fi
  fi

  stamp="$(date -u +%Y%m%d-%H%M%S)"
  keep="$VAR_DIR/backups/pre-restore-$stamp"
  mkdir -p "$keep"
  chmod 700 "$keep"
  cp -p "$SECRETS_ENV_FILE" "$keep/secrets.env" 2>/dev/null || true
  [[ ! -f "$STACKPORT_ENV_FILE" ]] || cp -p "$STACKPORT_ENV_FILE" "$keep/stackport.env"

  log "stopping stackport"
  compose stop stackport >/dev/null
  # A handoff left by an earlier attempt belongs to another archive and must never be adopted.
  handoff="$VAR_DIR/data/.restore-secrets.env"
  rm -f "$handoff"
  # No -u: the image's entrypoint starts as root and drops to the app user itself.
  compose run --rm --no-deps -T -e STACKPORT_BACKUP_PASSPHRASE stackport node "$BACKUP_CLI" restore "$STAGED_CONTAINER_FILE" --mode "$mode" --yes || rc=$?
  drop_staged_file
  if (( rc != 0 )); then
    rm -f "$handoff"
    error "restore failed; the previous installation is unchanged. Starting it again."
    compose up -d stackport >/dev/null || true
    exit "$rc"
  fi

  # The restored ciphertext only decrypts with the archive's keys.
  # The database is already replaced here, so the keys are merged into a copy and moved into place
  # in one step: secrets.env is either entirely the old file or entirely the merged one.
  if [[ -f "$handoff" ]]; then
    if ! merge_restore_secrets "$handoff"; then
      error "the database was restored but the archive's keys could not be written to $SECRETS_ENV_FILE."
      error "They are kept in $handoff (mode 600). Merge them into secrets.env by hand, then run 'stackport up'. The previous secrets.env is $keep/secrets.env."
      exit 1
    fi
    rm -f "$handoff"
    log "adopted the archive's encryption keys into $SECRETS_ENV_FILE (previous copy: $keep/secrets.env)"
  fi
  chown "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$VAR_DIR/data" 2>/dev/null || true

  ensure_env_file
  log "starting stackport"
  compose up -d --force-recreate stackport >/dev/null
  if (( no_admin )); then
    log "restore complete ($mode). The archive holds no administrator password: run 'stackport admin-recovery' to set one."
  else
    log "restore complete ($mode). Sign in with the administrator password the archive was made with."
  fi
  if [[ "$mode" == "clone" ]]; then
    log "this is a clone: projects are paused, API tokens and the GitHub App were removed, automation is off. Review each before enabling it."
  else
    log "if this is a different machine, check the domain and certificates (nginx_app_domain, Let's Encrypt)."
  fi
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

  remove_power_units
  if [[ -f "$COMPOSE_FILE" ]]; then
    log "stopping and removing StackPort containers"
    compose down --remove-orphans || true
  fi
  docker network rm stackport-proxy >/dev/null 2>&1 || true

  if [[ "$purge" == "--purge" ]]; then
    log "removing $ETC_DIR and $VAR_DIR"
    rm -rf "$ETC_DIR" "$VAR_DIR"
    # The self-signed bootstrap cert (src/modules/ingress/nginx/selfSignedCert.ts) lives
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

# ── power (reboot the host, from SSH or from Host > Power) ─────────────────────
# Stackport runs in a container with no way to reboot the machine it is on, and it should not get one. Instead the app writes a signed
# request file into its data directory and a systemd path unit on the host acts on it. The request carries an HMAC made with
# STACKPORT_POWER_KEY (secrets.env, root only; the app has the same value in its environment), a timestamp and the action; this script
# refuses anything unsigned, stale, malformed or too large, and consumes the request before acting, so a failure cannot loop.
#
# The app's data directory belongs to the app, so root treats everything in it as hostile: a request is read as the app's own user (so a
# link or a pipe in its place can reach nothing the app could not already read), and root never writes there. What root has to tell the
# app (that the units are installed, and what happened to the last request) goes in a root-owned directory the container mounts read-only.

POWER_DIR="${POWER_DIR:-$VAR_DIR/data/power}"            # requests, written by the app
POWER_STATE_DIR="${POWER_STATE_DIR:-$VAR_DIR/power}"     # ready, status, last-error: written by root, read by the app
POWER_UNIT_DIR="${POWER_UNIT_DIR:-/etc/systemd/system}"
POWER_MAX_AGE_S=300
POWER_MAX_DELAY_MIN=60

# HMAC-SHA256 (hex) over "action|requested_at|by|delay_min" with STACKPORT_POWER_KEY. The app signs the same string.
power_mac() {
  printf '%s|%s|%s|%s' "$1" "$2" "$3" "$4" | openssl dgst -sha256 -hmac "$STACKPORT_POWER_KEY" -hex | sed 's/^.*= //'
}

# Writes one small file of KEY=value lines into $POWER_STATE_DIR, atomically. The directory is root's, so this cannot be redirected.
power_write_state() {
  local name="$1"; shift
  mkdir -p "$POWER_STATE_DIR"
  local tmp
  tmp="$(mktemp "$POWER_STATE_DIR/.$name.XXXXXX")"
  printf '%s\n' "$@" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$POWER_STATE_DIR/$name"
}

# The schedule: what the host will do (scheduled with the time, or cancelled). A rejected request does not touch it, so a scheduled
# reboot stays cancellable from the UI after a bad request.
power_status() {
  local state="$1" reboot_at="${2:-}" by="${3:-}"
  local lines=("state=$state" "at=$(date +%s)")
  [[ -n "$reboot_at" ]] && lines+=("reboot_at=$reboot_at")
  [[ -n "$by" ]] && lines+=("by=$by")
  power_write_state status "${lines[@]}"
  rm -f "$POWER_STATE_DIR/last-error"
}

# The last request that was refused or failed, apart from the schedule.
power_error() {
  local detail
  detail="$(printf '%s' "$1" | tr -d '\r\n' | cut -c1-200)"
  power_write_state last-error "state=${2:-rejected}" "at=$(date +%s)" "detail=$detail"
}

# Reads at most 2 KiB of a request as the app's user, never as root, with a time limit (a pipe in its place would block).
power_read_request() {
  local path="$1"
  if [[ -n "${POWER_READ_AS:-}" ]]; then
    # A test hook that names a wrapper command, so the variable is deliberately split into words.
    # shellcheck disable=SC2086
    timeout 3 $POWER_READ_AS head -c 2048 -- "$path" 2>/dev/null
  else
    timeout 3 setpriv --reuid="${STACKPORT_UID:-1000}" --regid="${STACKPORT_GID:-1000}" --clear-groups head -c 2048 -- "$path" 2>/dev/null
  fi
}

# One value from a request, only if it is exactly one `key=value` line.
power_field() {
  local file="$1" key="$2"
  [[ "$(grep -c "^${key}=" "$file")" == "1" ]] || return 1
  grep "^${key}=" "$file" | cut -d= -f2-
}

# Checks a request file and prints "<action> <by> <delay_min>" when it is valid; otherwise prints the reason on stderr and fails.
power_verify() {
  local file="$1" expected="$2" action requested_at by delay mac now
  action="$(power_field "$file" action)" || { echo "no single action line" >&2; return 1; }
  requested_at="$(power_field "$file" requested_at)" || { echo "no single requested_at line" >&2; return 1; }
  by="$(power_field "$file" by)" || { echo "no single by line" >&2; return 1; }
  delay="$(power_field "$file" delay_min)" || { echo "no single delay_min line" >&2; return 1; }
  mac="$(power_field "$file" mac)" || { echo "no single mac line" >&2; return 1; }
  [[ "$action" == "$expected" ]] || { echo "the file is named for $expected but asks for something else" >&2; return 1; }
  [[ "$requested_at" =~ ^[0-9]{1,12}$ ]] || { echo "requested_at is not a time" >&2; return 1; }
  [[ "$by" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "by is not a plain name" >&2; return 1; }
  # 10# so a leading zero is a decimal number, not octal.
  [[ "$delay" =~ ^[0-9]{1,3}$ ]] && (( 10#$delay <= POWER_MAX_DELAY_MIN )) || { echo "delay_min is not 0 to $POWER_MAX_DELAY_MIN" >&2; return 1; }
  [[ "$mac" =~ ^[0-9a-f]{64}$ ]] || { echo "mac is not a hex digest" >&2; return 1; }
  [[ -n "${STACKPORT_POWER_KEY:-}" ]] || { echo "this host has no power key" >&2; return 1; }
  [[ "$(power_mac "$action" "$requested_at" "$by" "$delay")" == "$mac" ]] || { echo "the signature does not match" >&2; return 1; }
  now="$(date +%s)"
  (( 10#$requested_at <= now + 60 )) || { echo "the request is from the future" >&2; return 1; }
  (( now - 10#$requested_at <= POWER_MAX_AGE_S )) || { echo "the request is older than $POWER_MAX_AGE_S seconds" >&2; return 1; }
  printf '%s %s %s\n' "$action" "$by" "$delay"
}

# Schedules the reboot (delay_min 0 means now) and records it. SHUTDOWN_CMD is replaceable so the logic can be tested.
power_schedule() {
  local by="$1" delay=$((10#$2)) shutdown_cmd="${SHUTDOWN_CMD:-shutdown}" when
  if (( delay == 0 )); then when="now"; else when="+$delay"; fi
  "$shutdown_cmd" -r "$when" "Stackport: reboot requested by $by" || { power_error "shutdown refused the request" failed; return 1; }
  power_status scheduled "$(( $(date +%s) + delay * 60 ))" "$by"
  log "reboot scheduled ($when) for $by"
}

power_cancel() {
  local by="$1" shutdown_cmd="${SHUTDOWN_CMD:-shutdown}"
  "$shutdown_cmd" -c >/dev/null 2>&1 || true
  power_status cancelled "" "$by"
  log "scheduled reboot cancelled for $by"
}

# Run by the systemd service when a request file appears: handles each, consuming it first.
power_run() {
  load_secrets
  local name path copy reason fields action by delay content
  for name in reboot-request cancel-request; do
    path="$POWER_DIR/$name"
    [[ -e "$path" || -L "$path" ]] || continue
    copy="$(mktemp)"
    if [[ -L "$path" ]]; then
      : > "$copy"
    else
      content="$(power_read_request "$path" || true)"
      if (( ${#content} > 1024 )); then : > "$copy"; else printf '%s\n' "$content" > "$copy"; fi
    fi
    rm -f "$path"
    if ! fields="$(power_verify "$copy" "${name%-request}" 2>&1)"; then
      reason="$fields"
      rm -f "$copy"
      warn "refused $name: $reason"
      power_error "$reason" rejected
      continue
    fi
    rm -f "$copy"
    read -r action by delay <<< "$fields"
    if [[ "$action" == "reboot" ]]; then power_schedule "$by" "$delay" || true; else power_cancel "$by"; fi
  done
}

# Warns about containers that would not come back after a reboot: a restart policy of "no" means they stay stopped. Never fails: this is
# information, and a host whose Docker is down is exactly when someone needs to reboot it.
power_preflight() {
  local running unrestarted
  running="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ' || true)"
  unrestarted="$(docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' 2>/dev/null | awk '$2 == "" || $2 == "no" { sub(/^\//, "", $1); print $1 }' | tr '\n' ' ' || true)"
  log "${running:-0} containers are running"
  if [[ -n "${unrestarted// /}" ]]; then
    warn "these have no restart policy and will stay stopped after the reboot: $unrestarted"
  fi
  return 0
}

# stackport reboot [--in <minutes>] [--yes]
reboot_host() {
  local delay=0 assume_yes=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) assume_yes=1 ;;
      --in) shift; delay="${1:-}" ;;
      --in=*) delay="${1#--in=}" ;;
      *) error "unknown option: $1"; exit 1 ;;
    esac
    shift
  done
  [[ "$delay" =~ ^[0-9]{1,3}$ ]] && (( 10#$delay <= POWER_MAX_DELAY_MIN )) || { error "--in takes a number of minutes from 0 to $POWER_MAX_DELAY_MIN"; exit 1; }
  delay=$((10#$delay))
  power_preflight
  if (( assume_yes == 0 )); then
    require_interactive_tty
    read -r -p "Reboot this machine $( (( delay == 0 )) && echo now || echo "in $delay minute(s)")? Type REBOOT to continue: " confirm
    [[ "$confirm" == "REBOOT" ]] || { log "cancelled"; exit 0; }
  fi
  power_schedule "cli" "$delay"
}

# Installs the systemd units that act on a request from Host > Power, and tells the app they are there ($POWER_STATE_DIR/ready).
ensure_power_units() {
  # Root's directory: created by root, so nothing the app does can redirect what is written in it.
  mkdir -p "$POWER_STATE_DIR"
  chmod 755 "$POWER_STATE_DIR"
  # The app's directory: if it was replaced by a link, drop the link (rm removes the link, not what it points to) and make a real one.
  if [[ -L "$POWER_DIR" ]]; then rm -f "$POWER_DIR"; fi
  mkdir -p "$POWER_DIR"
  chown -h "${STACKPORT_UID:-1000}:${STACKPORT_GID:-1000}" "$POWER_DIR" 2>/dev/null || true
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    rm -f "$POWER_STATE_DIR/ready"
    warn "systemd is not running here, so Host > Power cannot reboot the machine; use 'sudo stackport reboot' over SSH"
    return 0
  fi
  if ! command -v setpriv >/dev/null 2>&1; then
    rm -f "$POWER_STATE_DIR/ready"
    warn "setpriv (util-linux) is missing, so Host > Power cannot read requests safely; use 'sudo stackport reboot' over SSH"
    return 0
  fi
  cat > "$POWER_UNIT_DIR/stackport-power.path" <<UNIT
[Unit]
Description=Act on a reboot or cancel request from Stackport (Host > Power)

[Path]
PathExistsGlob=$POWER_DIR/*-request
Unit=stackport-power.service

[Install]
WantedBy=multi-user.target
UNIT
  cat > "$POWER_UNIT_DIR/stackport-power.service" <<UNIT
[Unit]
Description=Stackport power request

[Service]
Type=oneshot
ExecStart=$CLI_TARGET power-run
UNIT
  systemctl daemon-reload
  systemctl enable --now stackport-power.path >/dev/null 2>&1 || { warn "could not start stackport-power.path"; rm -f "$POWER_STATE_DIR/ready"; return 0; }
  : > "$POWER_STATE_DIR/ready"
  log "Host > Power is enabled"
}

remove_power_units() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl disable --now stackport-power.path >/dev/null 2>&1 || true
  fi
  rm -f "$POWER_UNIT_DIR/stackport-power.path" "$POWER_UNIT_DIR/stackport-power.service" "$POWER_STATE_DIR/ready"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
}

# ── network-pool (enlarge Docker's address pool) ───────────────────────────────
# Every Docker network takes a slice of the daemon's address pools, and the stock pools hold 31. This sets `default-address-pools` in
# /etc/docker/daemon.json to a larger range after checking it against the host's own routes and interfaces, keeps a backup, restarts
# Docker only when asked, and puts the old file back if Docker does not come up. Existing networks keep their ranges.

DAEMON_JSON="${DAEMON_JSON:-/etc/docker/daemon.json}"
POOL_DEFAULT_BASE="10.20.0.0/14"
POOL_DEFAULT_SIZE=24

# "a.b.c.d/n" -> "start end" as integers. Fails on anything that is not a valid IPv4 CIDR (a bare address is a /32).
cidr_range() {
  local cidr="$1" ip prefix a b c d
  ip="${cidr%%/*}"
  if [[ "$cidr" == */* ]]; then prefix="${cidr#*/}"; else prefix=32; fi
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"; c="${BASH_REMATCH[3]}"; d="${BASH_REMATCH[4]}"
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || return 1
  [[ "$prefix" =~ ^[0-9]{1,2}$ ]] && (( prefix <= 32 )) || return 1
  local value=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  local size=$(( 1 << (32 - prefix) ))
  local start=$(( value - (value % size) ))
  printf '%s %s\n' "$start" "$(( start + size - 1 ))"
}

cidr_overlaps() {
  local one two
  one="$(cidr_range "$1")" || return 1
  two="$(cidr_range "$2")" || return 1
  local s1 e1 s2 e2
  read -r s1 e1 <<< "$one"
  read -r s2 e2 <<< "$two"
  (( s1 <= e2 && s2 <= e1 ))
}

# The IPv4 ranges the host itself uses, one per line: routes and interface addresses, except Docker's own bridges and loopback.
host_ranges() {
  {
    ip -4 -o route show 2>/dev/null | awk '$1 != "default" && $0 !~ /dev (docker0|br-|veth|lo)/ { print $1 }'
    ip -4 -o addr show 2>/dev/null | awk '$2 !~ /^(docker0|br-|veth|lo)/ { for (i = 1; i <= NF; i++) if ($i == "inet") print $(i + 1) }'
  } | sort -u
}

# Prints the daemon.json text with default-address-pools set, keeping every other key. Needs python3 or jq.
daemon_json_with_pool() {
  local base="$1" size="$2" file="$3"
  local py=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import json' >/dev/null 2>&1; then py="$candidate"; break; fi
  done
  if [[ -n "$py" ]]; then
    "$py" - "$file" "$base" "$size" <<'PY'
import json, sys
path, base, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(path) as f:
        text = f.read().strip()
    data = json.loads(text) if text else {}
except FileNotFoundError:
    data = {}
if not isinstance(data, dict):
    sys.exit("daemon.json is not a JSON object")
data["default-address-pools"] = [{"base": base, "size": size}]
print(json.dumps(data, indent=2))
PY
  elif command -v jq >/dev/null 2>&1; then
    if [[ -s "$file" ]]; then jq --arg base "$base" --argjson size "$size" '."default-address-pools" = [{"base": $base, "size": $size}]' "$file"
    else jq -n --arg base "$base" --argjson size "$size" '{"default-address-pools": [{"base": $base, "size": $size}]}'; fi
  else
    return 2
  fi
}

# The default-address-pools already in daemon.json, as "base size" lines; nothing when there are none (or no JSON tool to ask with).
daemon_json_existing_pools() {
  local file="$1" py=""
  [[ -s "$file" ]] || return 0
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import json' >/dev/null 2>&1; then py="$candidate"; break; fi
  done
  if [[ -n "$py" ]]; then
    "$py" - "$file" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for pool in (data.get("default-address-pools") or []) if isinstance(data, dict) else []:
    print(pool.get("base", "?"), pool.get("size", "?"))
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -r '(."default-address-pools" // [])[] | "\(.base) \(.size)"' "$file" 2>/dev/null || true
  fi
}

# The pools the daemon reports, e.g. "10.20.0.0/14 /24" per line; the stock pools when none are set.
docker_pools() {
  local out
  out="$(docker info --format '{{range .DefaultAddressPools}}{{.Base}} {{.Size}}{{"\n"}}{{end}}' 2>/dev/null || true)"
  if [[ -z "${out//[[:space:]]/}" ]]; then echo "stock (172.17.0.0/16 to 172.31.0.0/16, then 192.168.0.0/16 in /20 slices): 31 networks"; else printf '%s\n' "$out"; fi
}

# stackport network-pool [show]
network_pool_show() {
  log "Docker's address pools:"
  docker_pools | sed 's/^/  /'
  print_network_headroom
  if [[ -f "$DAEMON_JSON" ]]; then log "$DAEMON_JSON exists"; else log "$DAEMON_JSON does not exist (Docker's defaults apply)"; fi
  log "to enlarge: sudo stackport network-pool set --base $POOL_DEFAULT_BASE --size $POOL_DEFAULT_SIZE"
}

# stackport network-pool set --base <cidr> --size <n> [--replace] [--no-restart] [--yes]
network_pool_set() {
  local base="$POOL_DEFAULT_BASE" size="$POOL_DEFAULT_SIZE" restart=1 assume_yes=0 replace=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base) shift; base="${1:-}" ;;
      --base=*) base="${1#--base=}" ;;
      --size) shift; size="${1:-}" ;;
      --size=*) size="${1#--size=}" ;;
      --no-restart) restart=0 ;;
      --replace) replace=1 ;;
      --yes) assume_yes=1 ;;
      *) error "unknown option: $1"; exit 1 ;;
    esac
    shift
  done

  local prefix
  cidr_range "$base" >/dev/null || { error "--base must be an IPv4 range such as $POOL_DEFAULT_BASE"; exit 1; }
  [[ "$base" == */* ]] || { error "--base needs a prefix length, such as $POOL_DEFAULT_BASE"; exit 1; }
  prefix="${base#*/}"
  [[ "$size" =~ ^[0-9]{1,2}$ ]] || { error "--size must be a prefix length such as $POOL_DEFAULT_SIZE"; exit 1; }
  (( prefix >= 8 && prefix <= 24 )) || { error "the base range must be between /8 and /24"; exit 1; }
  (( size > prefix && size <= 28 )) || { error "--size must be larger than the base's /$prefix and at most 28"; exit 1; }
  local normalized_start given
  normalized_start="$(cidr_range "$base" | cut -d' ' -f1)"
  given="$(cidr_range "${base%%/*}" | cut -d' ' -f1)"
  [[ "$given" == "$normalized_start" ]] || { error "$base has host bits set; did you mean a range that starts on a /$prefix boundary?"; exit 1; }

  local capacity=$(( 1 << (size - prefix) ))
  log "pool: $base split into /$size networks = $capacity networks"

  local used clash=""
  while read -r used; do
    [[ -n "$used" ]] || continue
    if cidr_overlaps "$base" "$used"; then clash="$clash $used"; fi
  done < <(host_ranges)
  if [[ -n "$clash" ]]; then
    error "$base overlaps ranges this host already uses:$clash"
    error "pick another range (--base), for example 172.80.0.0/12 or 10.200.0.0/14, that nothing here or on your private networks uses"
    exit 1
  fi

  # Pools somebody already chose (to stay clear of a VPN, say) are not replaced without being asked.
  local existing
  existing="$(daemon_json_existing_pools "$DAEMON_JSON" || true)"
  if [[ -n "$existing" ]] && (( replace == 0 )); then
    error "$DAEMON_JSON already sets default-address-pools:"
    printf '%s\n' "$existing" | sed 's/^/  /' >&2
    error "a new pool replaces them, and networks made later could land in ranges they were chosen to avoid. Pass --replace to do that, or merge the ranges by hand."
    exit 1
  fi

  local merged
  merged="$(mktemp)"
  if ! daemon_json_with_pool "$base" "$size" "$DAEMON_JSON" > "$merged"; then
    rm -f "$merged"
    error "cannot change $DAEMON_JSON: it needs python3 or jq, and must be a valid JSON object. Set \"default-address-pools\" by hand: [{\"base\":\"$base\",\"size\":$size}]"
    exit 1
  fi
  if command -v dockerd >/dev/null 2>&1 && dockerd --help 2>&1 | grep -q -- '--validate'; then
    dockerd --validate --config-file="$merged" >/dev/null 2>&1 || { rm -f "$merged"; error "Docker would not accept the resulting configuration; $DAEMON_JSON was not changed"; exit 1; }
  fi

  local live_restore="no"
  grep -Eq '"live-restore"[[:space:]]*:[[:space:]]*true' "$merged" && live_restore="yes"
  if (( restart == 1 )); then
    power_preflight
    if [[ "$live_restore" == "yes" ]]; then log "live-restore is on: running containers should keep running while Docker restarts"
    else warn "restarting Docker stops every container, Stackport and nginx included, until they start again"; fi
    if (( assume_yes == 0 )); then
      require_interactive_tty
      read -r -p "Write $DAEMON_JSON and restart Docker now? Type RESTART DOCKER to continue: " confirm
      [[ "$confirm" == "RESTART DOCKER" ]] || { rm -f "$merged"; log "cancelled; nothing was changed"; exit 0; }
    fi
  fi

  local backup=""
  mkdir -p "$(dirname "$DAEMON_JSON")"
  if [[ -f "$DAEMON_JSON" ]]; then
    backup="$DAEMON_JSON.stackport-$(date +%Y%m%d%H%M%S).bak"
    cp -p "$DAEMON_JSON" "$backup"
    log "backed up $DAEMON_JSON to $backup"
  fi
  install -m 0644 "$merged" "$DAEMON_JSON"
  rm -f "$merged"
  log "wrote default-address-pools to $DAEMON_JSON"

  if (( restart == 0 )); then
    log "Docker was not restarted. The pool applies after: sudo systemctl restart docker"
    return 0
  fi

  log "restarting Docker"
  systemctl restart docker || true
  local waited=0
  until docker info >/dev/null 2>&1; do
    sleep 2; waited=$(( waited + 2 ))
    if (( waited >= ${NETWORK_POOL_WAIT_S:-60} )); then
      error "Docker did not come back with the new pool"
      if [[ -n "$backup" ]]; then
        cp -p "$backup" "$DAEMON_JSON"
      else
        rm -f "$DAEMON_JSON"
      fi
      warn "restored the previous $DAEMON_JSON; restarting Docker with it"
      systemctl restart docker || true
      exit 1
    fi
  done
  log "Docker is back"
  if [[ -f "$COMPOSE_FILE" ]]; then repair_stackport; fi
  network_pool_show
}

network_pool() {
  local sub="${1:-show}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    show) network_pool_show ;;
    set) network_pool_set "$@" ;;
    *) error "usage: stackport network-pool [show | set --base <cidr> --size <n> [--replace] [--no-restart] [--yes]]"; exit 1 ;;
  esac
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
  selfcheck)
    selfcheck_stackport
    ;;
  status)
    status_stackport
    ;;
  repair)
    require_root
    repair_stackport
    ;;
  reboot)
    require_root
    reboot_host "$@"
    ;;
  network-pool)
    if [[ "${1:-show}" == "set" ]]; then require_root; fi
    network_pool "$@"
    ;;
  power-run)
    require_root
    power_run
    ;;
  admin-recovery)
    admin_recovery
    ;;
  backup)
    require_root
    backup_stackport "$@"
    ;;
  backup-verify)
    require_root
    backup_verify_stackport "$@"
    ;;
  restore)
    require_root
    restore_stackport "$@"
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
