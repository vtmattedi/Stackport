#!/usr/bin/env bash
# End-to-end upgrade check: installs Stackport at BASE on this machine, then walks it
# through every update path a real server can take and asserts it always lands on a
# version that can be updated again.
#
#   sudo scripts/e2e/upgrade.sh <base-ref> <head-ref>
#
# Runs as root against the real /etc/stackport and /var/lib/stackport, because the
# updater container chroots into the host and runs the installed CLI with its default
# paths. Meant for a throwaway machine (the CI runner); refuses to touch an existing
# install unless E2E_FORCE=1.
set -euo pipefail

BASE_REF="${1:?usage: upgrade.sh <base-ref> <head-ref>}"
HEAD_REF="${2:?usage: upgrade.sh <base-ref> <head-ref>}"
SRC="$(git rev-parse --show-toplevel)"
WORK="${E2E_WORK:-/tmp/stackport-e2e}"
ORIGIN="$WORK/origin.git"
SCRATCH="$WORK/scratch"
APP_DIR=/var/lib/stackport/app
PORT=3000
# Versions before the stable branch follow main unless told otherwise; real servers
# reach stable through their first update, which installs the new CLI.
export STACKPORT_BRANCH=stable

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '\033[32mok: %s\033[0m\n' "$*"; }

[[ "$(id -u)" == 0 ]] || fail "run as root"
if [[ -e /etc/stackport && "${E2E_FORCE:-0}" != 1 ]]; then
  fail "/etc/stackport exists; this script installs over it (set E2E_FORCE=1 on a throwaway machine)"
fi

running_sha() { git -C "$APP_DIR" rev-parse HEAD; }
running_image() { docker inspect --format '{{.Image}}' stackport; }
state() { grep -m1 "^$1=" /var/lib/stackport/update/state.env | cut -d= -f2-; }

# Accepted means what update promises: ready, UI served, and able to update again.
assert_accepted() {
  local expect="$1" label="$2"
  [[ "$(running_sha)" == "$expect" ]] || fail "$label: checkout is $(running_sha), expected $expect"
  curl -fsS "http://localhost:$PORT/health" >/dev/null || fail "$label: /health"
  # Versions from before the readiness check don't have /health/ready.
  if git -C "$APP_DIR" cat-file -e HEAD:src/services/readiness.ts 2>/dev/null; then
    curl -fsS -o /dev/null "http://localhost:$PORT/health/ready" || fail "$label: /health/ready"
  fi
  local asset
  asset="$(curl -fsS "http://localhost:$PORT/" | grep -o '/assets/[^"]*\.js' | head -1)"
  [[ -n "$asset" ]] && curl -fsS -o /dev/null "http://localhost:$PORT$asset" || fail "$label: UI assets"
  if grep -q '^  selfcheck)' /usr/local/bin/stackport; then
    stackport selfcheck >/dev/null || fail "$label: installed CLI fails selfcheck"
  fi
  pass "$label (${expect:0:7})"
}

# Publishes a commit on top of $1 to origin/stable, the branch servers follow.
# $3 edits the scratch tree.
publish() {
  local parent="$1" message="$2" edit="$3"
  git -C "$SCRATCH" checkout --quiet --detach "$parent"
  (cd "$SCRATCH" && eval "$edit")
  git -C "$SCRATCH" add -A
  git -C "$SCRATCH" -c user.name=e2e -c user.email=e2e@stackport.invalid commit --quiet -m "$message"
  git -C "$SCRATCH" push --quiet --force origin HEAD:refs/heads/stable
  git -C "$SCRATCH" rev-parse HEAD
}

marker() { echo "export const e2eMarker = \"$1\";" > src/e2eMarker.ts; }

step "prepare a local origin with main at base"
rm -rf "$WORK"; mkdir -p "$WORK"
BASE="$(git -C "$SRC" rev-parse "$BASE_REF^{commit}")"
HEAD="$(git -C "$SRC" rev-parse "$HEAD_REF^{commit}")"
git init --quiet --bare --initial-branch=main "$ORIGIN"
git -C "$SRC" push --quiet "$ORIGIN" "$BASE:refs/heads/main" "$BASE:refs/heads/stable" "$HEAD:refs/heads/e2e-head"
git clone --quiet "$ORIGIN" "$SCRATCH"

# The runner's firewall must stay off; a no-op ufw keeps install from enabling it.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/ufw"; chmod +x "$WORK/bin/ufw"
command -v ss >/dev/null || { printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/ss"; chmod +x "$WORK/bin/ss"; }

step "install base ${BASE:0:7}"
git -C "$SCRATCH" show "$BASE:stackport.sh" > "$WORK/stackport-base.sh"
PATH="$WORK/bin:$PATH" STACKPORT_REPO="file://$ORIGIN" STACKPORT_INGRESS_ATTEMPTS=90 \
  bash "$WORK/stackport-base.sh" install --yes --branch=stable
assert_accepted "$BASE" "base installed"

step "1. base -> head, driven by the base version's CLI"
git -C "$SCRATCH" push --quiet --force origin "$HEAD:refs/heads/stable"
stackport update
assert_accepted "$HEAD" "updated to head"
stackport selfcheck || fail "head's CLI fails its own selfcheck"

step "4. base code on head's database (manual rollback)"
stackport rollback | tee "$WORK/rollback.log"
grep -q 'restoring database' "$WORK/rollback.log" && fail "base needed a DB restore to run on head's schema"
assert_accepted "$BASE" "base runs on head's database"
stackport update
assert_accepted "$HEAD" "back on head"

step "2. head -> next, launched from the app the way the Update button does"
NEXT="$(publish "$HEAD" "e2e: next release" 'marker next')"
docker exec -u node stackport node -e \
  "require('./dist/services/selfUpdate').startSelfUpdate().then(r => console.log('updater', r.id.slice(0, 12)))"
for _ in $(seq 1 450); do
  [[ "$(docker inspect --format '{{.State.Running}}' stackport-updater)" == false ]] && break
  sleep 2
done
docker logs stackport-updater > "$WORK/updater.log" 2>&1 || true
cat "$WORK/updater.log"
[[ "$(docker inspect --format '{{.State.ExitCode}}' stackport-updater)" == 0 ]] || fail "in-app update exited non-zero"
grep -q '^\[stackport\] update complete$' "$WORK/updater.log" || fail "in-app update did not complete"
assert_accepted "$NEXT" "in-app update to next"

step "3a. a release whose image does not build is refused before anything changes"
BEFORE_IMAGE="$(running_image)"
BROKEN_BUILD="$(publish "$NEXT" "e2e: broken build" 'echo "RUN false" >> Dockerfile')"
if stackport update > "$WORK/broken-build.log" 2>&1; then cat "$WORK/broken-build.log"; fail "broken build was accepted"; fi
grep -q 'aborted before anything changed' "$WORK/broken-build.log" || { cat "$WORK/broken-build.log"; fail "no early abort"; }
[[ "$(running_image)" == "$BEFORE_IMAGE" ]] || fail "running container changed"
assert_accepted "$NEXT" "still on next after broken build ${BROKEN_BUILD:0:7}"

step "3b. a release that builds and passes /health but can't serve its UI rolls back without a rebuild"
BROKEN_RUN="$(publish "$NEXT" "e2e: broken runtime" 'echo "RUN rm /app/client/dist/index.html" >> Dockerfile')"
stackport update 2>&1 | tee "$WORK/broken-run.log"
grep -q '^\[stackport\] rollback complete$' "$WORK/broken-run.log" || fail "no rollback for ${BROKEN_RUN:0:7}"
grep -q 'rebuilding it' "$WORK/broken-run.log" && fail "rollback rebuilt instead of reusing the saved image"
[[ "$(running_image)" == "$BEFORE_IMAGE" ]] || fail "rollback is not running the previous image"
assert_accepted "$NEXT" "rolled back to next"

step "the fix ships through the same update path"
FIXED="$(publish "$NEXT" "e2e: fixed release" 'marker fixed')"
stackport update
assert_accepted "$FIXED" "updated to the fix"

step "an update never steps backwards when stable is behind"
git -C "$SCRATCH" push --quiet --force origin "$NEXT:refs/heads/stable"
stackport update | tee "$WORK/behind.log"
grep -q 'is ahead of origin/stable' "$WORK/behind.log" || fail "update did not recognise it is ahead of stable"
assert_accepted "$FIXED" "stayed on the fix"

step "all upgrade scenarios passed"
