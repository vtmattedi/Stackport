# Stackport improvement plan

Status: agreed scope, October 2026. Branch: `claude/peaceful-pasteur-evt5pf`.

This plan covers correctness fixes, technical debt, UI/UX, feature removals, a read-only
MCP server with real authentication, and a unified action runner. Most security
hardening (the Compose policy redesign, volume model, network isolation) is
**deliberately out of scope** and needs its own design pass against what is already
deployed. See [Deferred](#deferred-not-in-this-plan).

## Ratings

| Criticality | Meaning |
|---|---|
| 🔴 Critical | Host compromise from repository content |
| 🟠 High | Security hole, data loss or outage risk |
| 🟡 Medium | Correctness or maintainability |
| ⚪ Low | Polish |

| Effort | Meaning (one developer familiar with the code) |
|---|---|
| S | About a day or less |
| M | 2–4 days |
| L | 1–2 weeks |
| XL | More than 2 weeks |

## Ground rules for every PR

- **Deployed installs come first.** Every schema or behavior change states what happens
  to an existing install on `stackport update`, and is tested against an old-format
  database where relevant.
- **Existing projects keep their behavior** unless the admin opts in. New defaults apply
  to new projects only.
- **Tests ship with the change.** Rollback selection, `ensureRepo`, migrations and
  anything touching secrets get tests in the same PR (this is how T3 is delivered).
- **Docs ship with the change.** `Stackport.md` is updated in the same PR whenever
  behavior described there changes.
- Checks before every push: `npm run typecheck`, `npm run lint`, `npm test`,
  `npm --prefix client run build:dry`.

## Overview

| # | PR | Items | Crit | Effort | Depends on | Status |
|---|---|---|---|---|---|---|
| 1 | Rollback and auto-deploy correctness | C1, C2 | 🟠 | S | — | ✅ `c893c9c` |
| 2 | Migration framework | T1 | 🟡 | S–M | — | ✅ |
| 3 | README, package name, stale todos | T6 | ⚪ | S | — | ✅ |
| 4 | Health-gated deploys | C3 | 🟠 | M | 2 | ✅ |
| 5 | ~~One deploy-history table~~ folded into PR 8 | T2 | 🟡 | — | — | ↪ 8 |
| 6 | API tokens and read-only MCP over HTTP | MCP-1, S5 (part) | 🟠 | M–L | 2 | ✅ |
| 8 | Action runner, server side (includes T2) | RUN-1, T2 | 🟠 | L | 2 | ✅ |
| 9 | Data layer foundation and runner client | T5a, RUN-2 | 🟡 | M | 8 | ✅ |
| 10 | Data layer: remaining pages | T5b | 🟡 | L | 9 | ✅ |
| 11 | Data layer cleanup: remove polling | T5c | 🟡 | S | 10 | ✅ |
| 12 | Webhooks first, poller as fallback | R3 | 🟡 | S | — | ✅ |
| 13 | Remove the Hostinger feature | R1 | 🟡 | M | — | ✅ |
| 14 | Label the traffic window | R2 | ⚪ | S | — | ✅ |
| 15 | Safer destructive actions, env paste | U2, U5 | 🟡 | S–M | — | ✅ |
| 16 | Project page as routed tabs | T4 | 🟡 | L | 9 | ✅ |
| 17 | Navigation consolidation | U1 | 🟡 | M | 13, 16 | ✅ |
| 18 | Deploy and rollback preview | U3 | 🟡 | M | 1 | ✅ |
| 19 | Clear policy-violation display | U4 (part) | 🟡 | S | — | ✅ |
| 20 | Command palette | U6 | ⚪ | M | 16, 17 | |

Numbers skip 7: OAuth was deferred (see [Deferred](#deferred-not-in-this-plan)).

Rough total: 9–12 weeks for one developer. PRs 3, 12, 14, 15, 18 and 19 have no
dependencies and can be picked up in parallel with anything.

---

## Phase 1: correctness and foundations

### PR 1 — Rollback and auto-deploy correctness (C1, C2) ✅

Done in `c893c9c`.

- **C1:** a rollback marks the revision it replaces (`rolled_back_at`). The default
  target is the newest earlier revision that differs from the running one and isn't
  marked, so rolling back twice keeps going back. `POST /projects/:id/rollback` accepts
  an optional `deploymentId`; the Deployments card has a Restore button per revision.
  Ordering uses `id`, not the one-second `created_at`.
- **C2:** poller and webhook deploys check out exactly the commit that triggered them,
  after verifying it is on `origin/<branch>`. A force-pushed-away commit fails the
  deploy with that reason.
- **Upgrade note:** rollbacks made before this version are not marked, so the first
  default rollback after upgrading may pick a revision that was already rolled back
  from. Restore covers that case.

### PR 2 — Migration framework (T1) ✅

**Problem:** schema changes were `CREATE TABLE IF NOT EXISTS` plus try/catch `ALTER` in
`src/config/database.ts`, re-checked on every boot, with no record of what ran and no
place for one-time data changes.

**Constraint found while building it:** `stackport rollback` runs the previous
release's code on the already-migrated database, so migrations may only add (new
tables, nullable or defaulted columns, indexes, backfills). `tests/migrations.test.ts`
already enforced this for `database.ts`; it now also scans `src/migrations/`. Table
rebuilds (for example to change a `CHECK` constraint) are therefore off the table.

**What shipped:**
- The existing `initializeDatabase()` body is the baseline, unchanged and still run on
  every boot.
- New changes are numbered modules in `src/migrations/` (`001_…` onward), run once
  each, in order, recorded in `PRAGMA user_version`.
- Each migration runs in an IMMEDIATE transaction that re-reads the version first, so
  the app and a second process (MCP, admin-recovery CLI) starting together can't apply
  one twice. A failure rolls back that migration's changes and its version, and stops
  startup.
- A database newer than the code (after `stackport rollback`) is logged and left
  alone, not refused: refusing would break rollback.
- Migration 1 moves PR 1's `rolled_back_at` column into the new system.

**Effort:** S–M, less than estimated, because of the additive-only rule.

**Tests:** run-once and ordering, partial version, failure rollback, newer database,
second process, and an upgrade from a released install (`user_version` 0).

### PR 3 — README, package name, stale todos (T6) ✅

- Add `README.md`: what Stackport is, install command, link to `Stackport.md` and
  `Skills.md`.
- Rename the package from `stackport-mw-vps-manager` to `stackport`, regenerating
  `package-lock.json` with npm (not by hand). The Docker image name is unaffected.
  The client package keeps its name: regenerating its lockfile pulls in unrelated
  changes, and the name isn't shown anywhere.
- Replace `todos.md`: webhook deploys are already implemented; point to this plan.

### PR 4 — Health-gated deploys (C3) ✅

**Problem:** a deploy counts as successful when `docker compose up` exits 0, whether or
not the app works.

**Approach:**
- After `up`, if the project has a health check (a path and a domain), poll it every
  3 s for the project's grace period (default 60 s, 5–600 s), using the same probe as
  the periodic monitor. Rollbacks are verified the same way.
- Pass: record the revision as `active`, as today.
- Fail (D2): the revision stays `active` (it is what is running), a new
  `health_failed_at` column records the failure (added by a migration; a new status
  value would need a table rebuild, which the additive-only rule forbids), the UI shows
  it as unhealthy, and a notification goes out. Containers keep running.
- **Optional per-project toggle:** "Roll back automatically when the health check
  fails", which runs `rollbackProject` with the default target.
- Projects without a health check keep today's behavior, with a hint in the UI that
  deploys are not verified.

**Deployed installs:** no behavior changes until a project has a health check *and*
the deploy runs on the new version. Auto-rollback is off for every project until
enabled (D2).

**Shipped notes:**
- The health URL now follows the domain's SSL setting; the monitor used to always use
  HTTPS, so checks on non-SSL domains always reported down.
- The gate runs whether or not periodic monitoring is on (interval 0), like "Check now".
- The three copies of the alert-sending code in `notificationService.ts` are one helper.
- The project update logic exists twice (`routes/projects.ts` for the UI,
  `projectAdmin.ts` for the MCP server); both validate the new fields with the same
  parsers. Merging them remains open: the new HTTP MCP doesn't use either, so PR 6
  didn't need to.

**Tests:** URL scheme, no health check, immediate pass, pass within the grace period,
timeout, unhealthy marking, settings validation. The auto-rollback path is not covered
by an automated test (it runs a real `docker compose`).

### PR 5 — One deploy-history table (T2): folded into PR 8

**Found while starting it:** the two tables aren't duplicates.

| Table | What it is | Retention | Read by |
|---|---|---|---|
| `project_deployments` | Revision store: commit plus source and effective Compose blobs | 20 per project | Rollback, Revisions list |
| `project_deploys` | Event log of **auto-deploys only** (manual deploys never write it) | Unbounded | Insights deploy counts and success rate, "Recent deploys" |

Merging them would either grow the revision table without bound or cut Insights
history to 20 rows, and PR 8's `actions` table is a third action log. So instead, in
PR 8, `actions` becomes the single deploy log (manual, auto and rollback); Insights and
"Recent deploys" read from it; a migration copies existing `project_deploys` rows in;
`project_deploys` stops being written but stays for `stackport rollback`. This also
fixes manual deploys missing from "Recent deploys" and the success rate.

---

## Phase 2: MCP with token authentication

The existing stdio server (`src/mcp/server.ts`) stays as it is. The new server runs
**inside the Stackport process**, so it shares the per-project action lock and never
writes to the database from a second process.

### PR 6 — API tokens and read-only MCP over HTTP (MCP-1, S5 part) ✅

**Auth:**
- New table `api_tokens`: id, name, `token_hash` (SHA-256), display prefix, scopes,
  created, last used, optional expiry, revoked.
- Tokens look like `spk_<random>`, are shown once on creation, and are revoked from a
  new Settings → MCP page.
- Tokens are only valid on `/mcp`. They are never accepted on `/api`, and admin
  session tokens are never accepted on `/mcp`, the same separation setup tokens use.
- Scope `read` only for now. The scope check is in place so write scopes can be added
  later without redesign.
- Per-token rate limit. Every tool call goes to the audit log with the token id and
  tool name (arguments only when they are ids).

**Transport:** MCP Streamable HTTP at `/mcp`, stateless, behind the existing nginx.
Works with Claude Code (`claude mcp add --transport http <url> --header
"Authorization: Bearer spk_…"`) and Claude Desktop.

**Tokens only.** claude.ai custom connectors (web and mobile) appear to require OAuth,
so they can't connect to this version. OAuth is deferred.

**Tools:**
- `stackport_status`: version, project counts by state.
- `stackport_list_projects`: id, name, group, source type, repo as `owner/name` (any
  credentials stripped from URLs), branch, deploy trigger, paused, health status with
  last check time and response time, last commit (SHA, message, author, time), pending
  deploy SHA, domains (hostname, SSL on/off).
- `stackport_get_project`: the above, plus Compose file name, the last 10 deployments
  (status, SHA, branch, trigger, time, Stackport's short block reason), containers
  (service, state, health, image), and the running action if any.

**Never returned:** anything stored encrypted, credential ids or aliases, env files
(values *and* names), `nginxExtraConfig` / `nginxExtraBlocks`, webhook slugs or
secrets, build or action logs. Output is built by explicit allowlist functions, never
by passing a database row through.

**Tests:** a test asserts every tool's output keys are exactly the allowlist, and that
no output contains seeded secret values; token hashing, revocation, wrong-scope and
wrong-namespace rejection.

---

## Phase 3: action runner and data layer

### PR 8 — Action runner, server side (RUN-1, T2) ✅

**Problem:** action tracking has three mechanisms depending on action type, live output
only for the project build slot, no sequence numbers (lines duplicated or lost around a
reload), and everything in memory (a Stackport restart loses records, and running
builds vanish without a trace).

**Approach:**
- Every action goes through one runner: project actions, SSL, nginx, certbot, Docker
  prune, upload, and self-update status.
- New table `actions`: id, key, kind, project, status (`running`, `success`, `failed`,
  `cancelled`, `interrupted`), started, finished, exit code, triggered by. On startup,
  rows still `running` become `interrupted`.
- **Output:** in-memory buffer per action with a sequence number per chunk, sent in
  batches about every 100 ms, also appended to `logs/actions/<id>.log`. Builds use
  `--progress=plain` so carriage-return progress bars don't garble the log.
- **Protocol:** small `action:started`, `action:progress` and `action:finished` events
  to everyone; full output only to clients that call `action:attach {id, fromSeq}`,
  which replays from the buffer or file and then streams live.
- Actions surviving a Stackport restart (running them in separate helper containers)
  is out of scope.

**Action logs on disk (accepted risk, must be documented):** build output often prints
environment values, and persisting it stores them. Required in this PR:
- **Masking:** before output is stored or streamed, values from the project's managed
  env files and Stackport-held credentials (6+ characters) are replaced with `***`.
  This doesn't catch secrets the app prints that Stackport doesn't manage.
- **Retention:** keep the last 20 runs per action key and nothing older than 30 days,
  whichever is less. Enforced on every action finish and on startup.
- **Deletion:** log files are deleted with the project, on Stop & Delete Data, and from
  a "Clear logs" button on the project page.
- **Permissions:** files readable only by the app user.
- **Documentation:** a new entry in `Stackport.md` §7 (security model) describing what
  is stored, where, for how long, and how to delete it.

**Shipped notes:**
- Built on the existing `actionRegistry`, whose API is unchanged, so every caller kept
  working; the older socket events (`project:deploy`, `actions:changed`, ...) stay until
  the client moves to the new ones in PR 9. The older per-line `project:deploy` stream
  is now masked too.
- Includes T2 (see PR 5): Insights and "Recent deploys" read deploy-type actions
  (deploy, rollback, recreate, force rebuild, Compose up, upload) from `actions`, so
  manual deploys now count.
- SSL issuance and system actions store only their final output, not live progress.
- New routes: `GET /api/actions/running`, `GET /api/actions/:id/log`,
  `DELETE /api/projects/:id/action-logs`.

**Tests:** persistence, numbering and batching, masking (including a secret split
across writes), partial-line hold-back, non-streaming output, replay from memory and
from file, annotation, interrupted-on-startup, retention by count and age, deletion,
the "Recent deploys" route, and the backfill migration.

### PR 9 — Data layer foundation and runner client (T5a, RUN-2) ✅

Adopt TanStack Query (D3).

- Provider, a query-key factory (`['projects']`, `['project', id]`,
  `['project', id, 'deployments']`, `['actions']`), and one socket bridge that turns
  events into cache updates.
- Move the projects list and project detail to queries.
- On connect, read the running-actions list: every running action gets a toast or dock
  entry, whoever started it and whenever.
- One `<ActionLog actionId>` component replacing the current three log paths; it keeps
  the last seen sequence number in `sessionStorage` to resume after a reconnect.

### PR 10 — Data layer: remaining pages (T5b) ✅

Migrate the remaining pages and contexts page by page, deleting their hand-written
fetch/state code as each one moves.

**Shipped notes (PRs 9 and 10):**
- One client action tracker (`context/ActionTracker.tsx`) replaces six ways of waiting
  for an action, including both 1.5 s polling loops. Toasts come from one component for
  every action, whoever started it.
- The project page derives its busy states, result line and log from the running and
  last-finished action, and attaches to the log live (`useActionOutput`). Leaving and
  reopening a project mid-build, or reloading, shows the same log. Its server data
  (project, domains, TCP ports, env files, deploys, revisions) is in the query cache.
- Pushed channels (system, projects, VPS) live in the query cache: one copy per
  channel instead of one per component. Insights' hand-built cache and Logs' interval
  are queries now.
- Measured: an idle project page makes no API requests over 30 s.
- Not moved: one-shot form loads (credentials form, notification and maintenance
  settings) keep their `useEffect`, as they gain nothing from a shared cache. The
  `sessionStorage` sequence idea wasn't needed: a reload replays the full log, and a
  reconnect resumes from the last sequence held in memory.

### PR 11 — Data layer cleanup (T5c) ✅

- Delete `pollProjectAction` and `SystemContext`'s store.
- Lower the global rate limit from 1000 per 15 minutes once polling is gone, sized from
  measured traffic.

**Shipped notes:**
- Both polling loops went in PR 9. This PR removes what nothing used any more: the
  per-line `project:deploy` socket stream and the `actions:changed` ping on the server,
  `GET /api/projects/actions/running`, and the client's deploy-subscription helpers.
  The wizard's live logs attach through the tracker like the project page.
- `SystemContext`'s selector store stays: it is a thin `useSyncExternalStore` layer that
  lets a component re-render only for its slice, over data that now lives in the query
  cache (no second copy). Replacing it would mean rewriting ~15 consumers for no change
  in behavior.
- Global rate limit: 600 per 15 minutes (was 1000), from measured traffic: about 11 API
  requests per full page load, 122 for 54 in-app page changes, none while idle.

---

## Phase 4: product cleanup

### PR 12 — Webhooks first, poller as fallback (R3) ✅

Webhook deploys already exist (`0f05f63`). Remaining:
- New projects default to the `webhook` trigger when the app has an HTTPS domain
  (webhooks require HTTPS).
- If a project's webhook status is `failing`, or has been `waiting` for longer than a
  set time, the poller covers it and the UI says so.
- Existing projects keep their current trigger.

**Shipped notes:** the 30-minute webhook safety check already existed and already
marked a hook failing when it caught a missed push. What changed: a failing hook is now
polled at the normal interval until a delivery succeeds, and the wizard defaults new
GitHub projects to the webhook when Stackport is on HTTPS. A hook still `waiting` for
its first delivery stays on the 30-minute check: there's no reliable "set up at" time
to tell a new hook from a broken one.

### PR 13 — Remove the Hostinger feature (R1) ✅

Not used on any deployed install (D1). Remove the UI, routes and services (about 1,600
lines). Stored Hostinger API key credentials stay in the credentials list for the
admin to delete. The database tables stay, unused, so `stackport rollback` to the
previous version still finds its schema (PR 2's additive-only rule).

**Shipped notes:** removed the VPS service and routes (`/api/vps`, `/api/vpi`), the
`vps` socket channel, the `HOSTINGER_*` env settings, the Infrastructure → VPS section,
Settings → Infrastructure (providers, monitored VMs, firewall) and their client API and
types. Insights used the cached VM list to recognize the server's own public IP; it now
learns that IP from requests carrying Stackport's health-check user agent. Insights'
"Block IP at edge" (which pointed at the removed firewall page) is now "Copy IP". Old
URLs redirect.

### PR 14 — Label the traffic window (R2) ✅

Insights traffic reads at most 20,000 recent nginx log lines, and history resets when
the container is recreated. Show the time range actually covered next to the period
picker, and say when the chosen period is longer than the data.

### PR 15 — Safer destructive actions, env paste (U2, U5) ✅

- Type the project name to confirm Stop & Delete Data, Drop volumes and Delete project.
- Env manager: paste a whole `.env` at once; flag `${VAR}` references in the Compose
  file that no managed env file defines.

**Shipped notes:**
- Pasting a whole `.env` already existed (Parse).
- The unset-variable check looks only at the project's root `.env` (managed or in the
  repository), because Compose fills `${VAR}` from that file and its own environment,
  never from `env_file:` entries. Variables with a default are not flagged. "Add to
  .env" adds empty rows for them.
- Delete project's confirmation now says what deletion actually does: containers keep
  running and the checkout stays on disk (the route never stopped them; the old text
  didn't say).
- **Found here:** S14 (deferred list). Compose runs with Stackport's whole environment,
  so a project's Compose file can read Stackport's secrets by name.

---

## Phase 5: UI structure

### PR 16 — Project page as routed tabs (T4) ✅

Split `ProjectDetails.tsx` (about 1,840 lines, 68 `useState`) into
`/projects/:id/{overview,deployments,domains,env,logs,settings}`. Each tab owns its
queries (after PR 9, mostly moving code). `/projects/:id` redirects to overview, and
existing query parameters such as `?setup=` keep working.

**Shipped notes:**
- Tabs: Overview (Docker, resources), Deploys (GitHub trigger, deployments), Domains
  (domains and TCP ports), Settings (config form, metadata), at `/projects/:id/:tab`;
  `/projects/:id` and unknown tabs show Overview. The status card, toolbar and action
  log stay above the tabs. No Env tab: the env manager is already a full dialog.
- Settings and Domains are their own components (`pages/project/SettingsTab.tsx`,
  `DomainsTab.tsx`) with their own state. Settings stays mounted while hidden, so
  unsaved edits survive switching tabs. Domain changes reach the form through project
  data instead of setting its fields directly.
- Overview and Deploys stay in `ProjectDetails.tsx`: they share the action handlers the
  toolbar uses. The file went from about 1,840 to 1,107 lines.

### PR 17 — Navigation consolidation (U1) ✅

From System, Infrastructure and Settings → Infrastructure overlapping, to:
**Projects · Insights · Logs · Host** (Docker, nginx, certificates, hardware)
**· Settings** (general, deploy triggers, notifications, credentials, MCP, maintenance).
Every old route redirects.

**Shipped notes:**
- Host (`/host/:section`) has Nginx, Docker, Certbot and Hardware. The old
  Infrastructure page is now the Hardware section (`pages/HardwareSection.tsx`).
- Credentials moved to `/settings/credentials`; every "manage credentials" link points
  there.
- Main nav: Projects, Host, Logs, Insights, Settings (mobile: the same, with More).
- Redirects: `/system/:section` → `/host/:section` (query string kept, so old
  `?tab=` links still resolve), `/infrastructure/*`, `/hardware`, `/vps` →
  `/host/hardware`, `/credentials` → `/settings/credentials`.

### PR 18 — Deploy and rollback preview (U3) ✅

Before a deploy: the commits between the running revision and the target. Before a
rollback or restore: the same, plus a diff of the effective Compose files. The
revision picker itself shipped in PR 1.

**Shipped notes:**
- `GET /api/projects/:id/deploy-preview?branch=` and `/rollback-preview?deploymentId=`
  (`services/deployPreview.ts`). Read-only: nothing touches the checkout, so a preview
  works while another action holds the project.
- Commits come from GitHub's compare API with the project's token: added and removed
  commits (the newest 50 of each, with totals), and whether the two have diverged.
- Compose diff: for a rollback, the effective files exactly as each revision ran (from
  `project_deployments`); for a deploy, the running revision's source file against the
  same file at the branch head (fetched from GitHub). The effective file of a deploy
  doesn't exist until Stackport writes it.
- A GitHub failure (rate limit, private repo without a token) shows as a note in the
  dialog; the deploy or rollback can still be confirmed.
- Redeploy now asks for confirmation, with the preview. Roll back and Restore show it
  in their existing confirmation. `ConfirmDialog` gained a `body` slot.
- Line diff in `services/textDiff.ts` (LCS after trimming the common start and end;
  reports "too large" past 4M cells instead of running long).

### PR 19 — Clear policy-violation display (U4, part) ✅

Show Compose policy rejections as a list (service, key, how to fix) instead of raw log
text. The volume-mapping display waits for the volume-model redesign (deferred S2).

**Shipped notes:**
- `validateComposePolicy` returns `{ service, key, problem, fix }` per violation; the
  deploy log keeps the `services.<name>.<key>: …` line, now with the fix appended.
- `GET /api/projects/:id/compose-policy` checks the selected Compose file in the
  checkout. The project page shows the violations as a table above the tabs, before
  any deploy is attempted, and refetches when a project action ends (after a pull).
- No checkout or no file selected yet returns an empty list, not an error.

### PR 20 — Command palette (U6)

Cmd/Ctrl-K: jump to a project or settings page, start deploy, open logs. Built on the
existing Radix primitives.

---

## Decisions

| # | Decision | Answer |
|---|---|---|
| D1 | Is the Hostinger fleet or firewall used on any deployed install? | No: remove it (PR 13) |
| D2 | Health check failure default | Mark failed and notify; auto-rollback is per-project opt-in |
| D3 | TanStack Query for the data layer? | Yes |
| D4 | One PR per item, or one branch? | One branch, one commit (or a few) per row |

## Deferred (not in this plan)

Needs a separate design against what is already deployed:

| Item | Crit | Notes |
|---|---|---|
| S14 Run `docker compose` with a minimal environment | 🔴 | **Found during PR 15.** `dotenv` loads Stackport's merged `.env` (`JWT_SECRET`, `WEBHOOK_SECRET`, `STACKPORT_REPO_TOKEN`) into `process.env`, and `dockerEnv()` passes all of it to every `docker compose` run. Any project's Compose file can use `${JWT_SECRET}` and receive the key that signs admin sessions and decrypts stored credentials; no policy bypass needed. Fix: pass only `PATH`, `HOME`, `DOCKER_CONFIG`, `DOCKER_HOST` (and the project's own `.env`, which Compose reads itself). Check deployed projects for `${...}` references that relied on Stackport's environment first |
| S1 Compose policy: allowlist validation of the resolved config | 🔴 | Eight demonstrated bypasses, including `volumes_from: ["container:stackport"]` (Docker socket) and `${VAR:-/}` mounts |
| S2 Volume model: Stackport-owned mount directories | 🔴 | Needed to close symlink escapes |
| S3 Take Stackport off the `stackport-proxy` network | 🟠 | Projects can call the API directly |
| S4 Narrow `trust proxy` | 🟠 | Spoofed `X-Forwarded-For` bypasses the login rate limit |
| S5 (rest) Write access over MCP | 🟠 | PR 6 builds the scoped-token base for it |
| S6 Session lifetime cap, httpOnly cookie | 🟡 | |
| S7 Separate encryption key with versioning | 🟡 | Needs PR 2 |
| S8 Hardened container defaults | 🟠 | Needs S1 |
| S9 Per-project ingress networks | 🟡 | Needs S3 |
| S10 Block cloud metadata and LAN egress | 🟡 | |
| S11 Docker socket containment (userns-remap, socket proxy) | 🟠 | |
| S12 `resolveContainedPath` should resolve symlinks | 🟡 | Unverified whether anything exploitable relies on it |
| MCP-2 OAuth for claude.ai connectors | 🟡 | Authorization code + PKCE with pre-registered clients, discovery metadata, consent page, short-lived access tokens on the PR 6 token table. Verify Anthropic's custom-connector requirements first |
| S13 Encrypt managed env values at rest | 🟡 | `project_env_files.variables_json` is plain text, unlike credentials, although `Stackport.md` §7 implied all stored secrets are encrypted. Found during PR 8 |
| N1 `/version.json` exposes the exact commit without auth | ⚪ | |
| A1 Deploy prebuilt images by digest | 🟡 | Needs S1 |
| A2 Scheduled off-host backups | 🟠 | |
| A3 Build before `up`, blue-green | ⚪ | |

**Until S1 and S2 land:** turn off auto-deploy for any repository that someone other
than the admin can push to.
