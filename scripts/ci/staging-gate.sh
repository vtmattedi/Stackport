#!/usr/bin/env bash
# P6: a change that touches Docker networks, mounts or start-up order must say it was run on a real host.
#
# Usage: staging-gate.sh <file listing the changed paths, one per line> <file holding the PR description>
# Exit 0: not required, or the description has a result. Exit 1: required and missing.
#
# The description needs a line `Staging host: <where and when>` followed by a line `Result: <what was checked>`,
# or `Staging host: not needed: <why>` when a listed file changed but cannot affect a real host (a comment, a test).
set -euo pipefail
changed="$1"
body="$2"

# Paths whose behaviour depends on a real Docker daemon, nginx or the host.
GATED='^(src/index\.ts|stackport\.sh|docker-compose\.system\.yml|Dockerfile|docker-entrypoint\.sh|src/modules/ingress/(networks|bootstrap|health|isolation|isolationState|tcp|hostnameOps|dnsCheck)\.ts|src/modules/ingress/certificates/|src/modules/ingress/nginx/|src/modules/deployments/compose/(networking|managedVolumes|seedVolumes|groupNetworks)\.ts|src/modules/deployments/networkGroupAssignment\.ts|src/modules/maintenance/(networkHeadroom\.ts|migrations/)|src/shared/ingressNames\.ts)'

hits="$(grep -E "$GATED" "$changed" || true)"
if [[ -z "$hits" ]]; then
  echo "No file that touches Docker networks, mounts or start-up changed: no staging result needed."
  exit 0
fi

echo "This change touches files that depend on a real host:"
echo "$hits" | sed 's/^/  /'

# Strip CRs: PR descriptions edited in the browser use CRLF.
text="$(tr -d '\r' < "$body")"
if grep -qiE '^Staging host:[[:space:]]*not needed:[[:space:]]*[^[:space:]]' <<< "$text"; then
  echo "Staging host: marked not needed, with a reason."
  exit 0
fi
if grep -qiE '^Staging host:[[:space:]]*[^[:space:]]' <<< "$text" && grep -qiE '^Result:[[:space:]]*[^[:space:]]' <<< "$text"; then
  echo "Staging host and result present."
  exit 0
fi

cat <<'MSG'

Add these two lines to the pull request description (see docs/staging-gate.md):

  Staging host: <host and date the change was run on>
  Result: <what you checked and what happened>

or, if the change cannot affect a real host:

  Staging host: not needed: <why>
MSG
exit 1
