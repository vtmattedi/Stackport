# Backlog: not security

Features that were proposed and deferred, and smaller issues found while building 1.2.
Ratings are explained in [README.md](README.md).

## Features

### A2 — Scheduled off-host backups · 🟠 · M

Stackport backs up its database only right before a self-update, on the same disk. A
lost disk loses the database, the credentials and every project's state. Scheduled
backups of the database and the env files to an S3-compatible target, with retention
and a restore command in `stackport.sh`.

### MCP-2 — OAuth for claude.ai connectors · 🟡 · L

1.2's MCP accepts API tokens only (by decision). claude.ai custom connectors need
OAuth: authorization code with PKCE, pre-registered clients, discovery metadata, a
consent page, short-lived access tokens on the existing token table. Check
Anthropic's current custom-connector requirements before starting. (This was PR 7 in
the 1.2 plan.)

### A1 — Deploy prebuilt images by digest · 🟡 · M · needs S1

Deploy a project from an image reference pinned by digest instead of building from
the repository. Needs S1, or the Compose file around the image is still trusted.

### U4b — Show volume mappings on the project page · 🟡 · S · needs S2

The other half of U4: list each service's volumes and where they live on the host.
Waits for S2, which decides where they live.

### A3 — Build before `up`, blue-green · ⚪ · L

Today `up -d --build` builds, then replaces each running container in place: a short
outage on every deploy, and a broken build is already serving before the health check
(PR 4) can say so. Start the new container alongside the old one, switch nginx once it
is healthy, then stop the old one.

## Small fixes

### B1 — Pin the rollback target from the preview · ⚪ · S

Roll back (without a chosen revision) previews the default target, then the POST
resolves the default again. If a deploy lands between the two, the rollback restores
a different revision than the one previewed. Send the previewed `targetId` with the
rollback.

### B2 — Upstream keepalive in the nginx proxy blocks · ⚪ · S

`locationBlock` (`src/services/nginx/configWriter.ts`) sets `Connection "upgrade"` on
every request, which disables upstream keepalive for ordinary requests. Use the
standard `map $http_upgrade $connection_upgrade` instead.

### B3 — Bound the GitHub ETag cache · ⚪ · S

`etagCache` in `src/services/githubPoller.ts` never evicts. Bounded in practice by
projects × branch-list pages, but an LRU cap is a few lines. (Deploy previews already
bypass it.)

### B4 — Palette: deploy a chosen branch · ⚪ · S

The command palette's Deploy action uses the auto-deploy branch only. Deploying
another branch still means opening the project.

### B5 — Lint warnings · ⚪ · M

`npm run lint` reports 110 warnings (0 errors), unchanged through 1.2: mostly
`security/detect-object-injection` and `detect-non-literal-fs-filename` false
positives, and missing return types. Fix or suppress each with a reason, then make
warnings fail CI so the count can't grow.

### B6 — `Stackport.md` for 1.2's behaviour changes · ⚪ · S

The 1.2 plan's rule was to update `Stackport.md` with each behaviour change. It still
needs: the Host section and the nav (PR 17), deploy and rollback previews (PR 18), the
read-only host mounts (PR 24), the status strip (PR 25), and the socket reconnect
behaviour (PR 21).

### B7 — Delete `docs/deprecated/` · ⚪ · S

Dropped by decision; deleting it stops anyone reading it as current.

### B8 — Delete merged remote branches · ⚪ · S

As of 1.2.0 every `claude/*` branch below has its work in `main` and no open pull
request. Three of them carry merge commits that `main` doesn't have, but every commit
those merges brought in is in `main`, so nothing is lost:

- `claude/project-thread-c7ugcc` (2 merge commits)
- `claude/project-thread-w1ye4y` (1 merge commit)
- `claude/project-thread-w1ye4y-update-hooks` (1 merge commit)
- `claude/project-thread-w1ye4y-triggers`, `-webhooks`, `-ui-wave1` … `-ui-wave5`
  (fully merged)

`claude/peaceful-pasteur-evt5pf` is the 1.2 working branch: delete it once 1.2.0 is
merged. `main` and `stable` stay: servers update from `stable`.

### N1 — `/version.json` exposes the exact commit without auth · ⚪ · S

The PWA polls `/version.json` to notice a new deploy, so it answers without a login
and returns the running commit. That tells anyone exactly which version (and which
known bugs) a server runs. Return an opaque build id instead, such as a hash of the
commit with a per-install salt.
