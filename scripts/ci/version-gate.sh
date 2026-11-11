#!/usr/bin/env bash
# A pull request to main must carry the version it releases: the number in package.json must be higher than main's, and a branch
# named like a version (1.3.9) must be that version. Otherwise a server running the release reports an older number than the
# one that shipped (1.3.7 ran as "v1.3.1" because nobody had bumped package.json).
#
# Usage: version-gate.sh <head branch> <head version> <base version>
# Exit 0: fine. Exit 1: the version is not raised, or does not match the branch name.
set -euo pipefail
branch="$1"
head="$2"
base="$3"

plain='^[0-9]+\.[0-9]+\.[0-9]+$'
if ! [[ "$head" =~ $plain && "$base" =~ $plain ]]; then
  echo "Version gate: expected plain versions such as 1.3.9, got head='$head' base='$base'." >&2
  exit 1
fi
if [ "$head" = "$base" ] || [ "$(printf '%s\n%s\n' "$base" "$head" | sort -V | tail -n 1)" != "$head" ]; then
  echo "Version gate: package.json says $head, which is not higher than main's $base. Raise the version (package.json, package-lock.json, build-info.json and the client's copies: tests/versionConsistency.test.ts lists them)." >&2
  exit 1
fi
if [[ "$branch" =~ $plain && "$branch" != "$head" ]]; then
  echo "Version gate: the branch is named $branch but package.json says $head." >&2
  exit 1
fi
echo "Version gate: $head (main is $base)."
