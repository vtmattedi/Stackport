#!/usr/bin/env bash
# Host-tooling checks with fake commands; never touches the host Docker daemon.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../stackport.sh
source "$ROOT/stackport.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export ETC_DIR="$WORK/etc" VAR_DIR="$WORK/var" APP_DIR="$WORK/app"
STATE_FILE="$VAR_DIR/update/state.env"
STAGING_DIR="$VAR_DIR/update/staging"
CALLS="$WORK/calls"
BUILDX_READY=0
COMPOSE_READY=1
INSTALL_FAIL=0
APT_ORIGIN=https://download.docker.com/linux/debian

apt-cache() { echo " 500 $APT_ORIGIN bookworm/stable amd64 Packages"; }
apt-get() {
  echo "apt-get $*" >> "$CALLS"
  [[ "$1" != install || "$INSTALL_FAIL" == 0 ]]
}
# Model successful installation using the call log.
docker() {
  echo "docker $*" >> "$CALLS"
  case "$*" in
    'buildx version')
      [[ "$BUILDX_READY" == 1 || -f "$WORK/docker-installed" ]] || { [[ "$INSTALL_FAIL" == 0 ]] && grep -q '^apt-get install ' "$CALLS"; } ;;
    'compose version') [[ "$COMPOSE_READY" == 1 || -f "$WORK/docker-installed" ]] ;;
    '--version') echo 'Docker test version' ;;
    *) echo "unexpected Docker command: $*" >&2; return 1 ;;
  esac
}
fail() { echo "FAIL: $*" >&2; exit 1; }
reset_calls() { : > "$CALLS"; }

reset_calls
COMPOSE_READY=0
curl() { printf 'touch "%s/docker-installed"\n' "$WORK"; }
systemctl() { return 0; }
ensure_docker
[[ -f "$WORK/docker-installed" ]] || fail 'Docker installation was skipped'
grep -q '^docker buildx version$' "$CALLS" || fail 'new Docker skipped Buildx validation'
rm "$WORK/docker-installed"
COMPOSE_READY=1
unset -f curl systemctl
echo 'PASS: newly installed Docker validates Buildx'

reset_calls
BUILDX_READY=1
ensure_docker
grep -q '^docker buildx version$' "$CALLS" || fail 'existing Docker skipped Buildx validation'
if grep -q '^apt-get ' "$CALLS"; then fail 'working Buildx triggered apt'; fi
echo 'PASS: existing Docker validates Buildx without installing anything'

BUILDX_READY=0
# The official-repository checks apply only on supported hosts.
if docker_official_apt_available; then
  reset_calls
  ensure_docker
  grep -q '^apt-get update$' "$CALLS" || fail 'missing apt refresh'
  grep -q '^apt-get install .*docker-buildx-plugin$' "$CALLS" || fail 'missing plugin install'
  echo 'PASS: bootstrap installs missing Buildx from the official apt repository'

  reset_calls
  INSTALL_FAIL=1
  if ensure_buildx > "$WORK/install-failed.log" 2>&1; then fail 'failed apt install accepted'; fi
  grep -q 'then retry' "$WORK/install-failed.log" || fail 'failed install has no recovery instruction'
  INSTALL_FAIL=0
  echo 'PASS: failed plugin installation gives recovery instructions'
fi

reset_calls
APT_ORIGIN=https://deb.debian.org/debian
if ensure_buildx > "$WORK/no-repo.log" 2>&1; then fail 'missing official repository accepted'; fi
if grep -q '^apt-get install ' "$CALLS"; then fail 'attempted plugin install from an arbitrary repository'; fi
grep -q 'official apt repository configured' "$WORK/no-repo.log" || fail 'missing apt recovery instructions'
grep -q 'https://docs.docker.com/build/buildx/' "$WORK/no-repo.log" || fail 'missing other-platform instructions'
echo 'PASS: bootstrap refuses to assume the plugin exists in a distro repository'

reset_calls
(
  cleanup_staging() { fail 'missing Buildx reached staging cleanup'; }
  git() { fail 'missing Buildx reached worktree creation'; }
  if stage_update 123456789abcdef > "$WORK/stage.log" 2>&1; then fail 'staging accepted missing Buildx'; fi
)
[[ ! -e "$STAGING_DIR" && ! -e "$STATE_FILE" ]] || fail 'failed preflight changed installation state'
grep -q 'running StackPort image has not been changed' "$WORK/stage.log" || fail 'missing untouched-image message'
echo 'PASS: missing Buildx aborts before staging or changing the running image'

reset_calls
(
  git() { return 0; }
  curl() { return 0; }
  if selfcheck_stackport > "$WORK/selfcheck.log" 2>&1; then fail 'selfcheck accepted missing Buildx'; fi
  grep -q 'Docker Buildx is missing or unusable' "$WORK/selfcheck.log" || fail 'selfcheck did not report missing Buildx'
  BUILDX_READY=1
  selfcheck_stackport
)
BUILDX_READY=1
(
  cleanup_staging() { echo staging-reached > "$WORK/retry"; }
  git() { return 1; }
  stage_update 123456789abcdef >/dev/null 2>&1 || true
)
[[ -f "$WORK/retry" ]] || fail 'installing Buildx did not allow staging retry'
echo 'PASS: selfcheck rejects missing Buildx and installing it allows retry'
