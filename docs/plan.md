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
| 2 | Migration framework | T1 | 🟡 | M | — | |
| 3 | README, package name, stale todos | T6 | ⚪ | S | — | |
| 4 | Health-gated deploys | C3 | 🟠 | M | 2 | |
| 5 | One deploy-history table | T2 | 🟡 | M | 2 | |
| 6 | API tokens and read-only MCP over HTTP | MCP-1, S5 (part) | 🟠 | M–L | 2 | |
| 8 | Action runner, server side | RUN-1 | 🟠 | M–L | 2 | |
| 9 | Data layer foundation and runner client | T5a, RUN-2 | 🟡 | M | 8 | |
| 10 | Data layer: remaining pages | T5b | 🟡 | L | 9 | |
| 11 | Data layer cleanup: remove polling | T5c | 🟡 | S | 10 | |
| 12 | Webhooks first, poller as fallback | R3 | 🟡 | S–M | — | |
| 13 | Remove the Hostinger feature | R1 | 🟡 | M | — | |
| 14 | Label the traffic window | R2 | ⚪ | S | — | |
| 15 | Safer destructive actions, env paste | U2, U5 | 🟡 | S–M | — | |
| 16 | Project page as routed tabs | T4 | 🟡 | L | 9 | |
| 17 | Navigation consolidation | U1 | 🟡 | M | 13, 16 | |
| 18 | Deploy and rollback preview | U3 | 🟡 | M | 1 | |
| 19 | Clear policy-violation display | U4 (part) | 🟡 | S | — | |
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

### PR 2 — Migration framework (T1)

**Problem:** schema changes are `CREATE TABLE IF NOT EXISTS` plus try/catch `ALTER` in
`src/config/database.ts`. There is no record of which changes ran, and anything beyond
adding a column (changing a `CHECK` constraint, renaming, rebuilding a table) can't be
done safely.

**Approach:**
- Track the schema version with `PRAGMA user_version`.
- Migration 1 is the baseline: today's `initializeDatabase()` body, unchanged. It is
  idempotent already, so it runs as-is on fresh and legacy databases and then sets
  version 1.
- New changes are numbered modules in `src/migrations/NNN_name.ts`, each exporting
  `up(db)`, run in order inside a transaction. A failure rolls that migration back and
  stops startup with a clear error.
- Refuse to start on a database with a *higher* version than the code knows (a
  downgrade), with a message pointing to `stackport rollback`.
- The MCP server and other secondary processes never run migrations (see PR 6).

**Deployed installs:** `stackport update` already backs up the database before
updating. The baseline migration changes nothing on an up-to-date install; it only
records version 1.

**Tests:** extend `tests/migrations.test.ts` with an old-format fixture (missing recent
columns), a fresh database, a failing migration that must roll back, and the downgrade
refusal.

### PR 3 — README, package name, stale todos (T6)

- Add `README.md`: what Stackport is, install command, link to `Stackport.md` and
  `Skills.md`.
- Rename the package from `stackport-mw-vps-manager` to `stackport`, regenerating
  `package-lock.json` with npm (not by hand). The Docker image name is unaffected.
- Replace `todos.md`: webhook deploys are already implemented; point to this plan.

### PR 4 — Health-gated deploys (C3)

**Problem:** a deploy counts as successful when `docker compose up` exits 0, whether or
not the app works.

**Approach:**
- After `up`, if the project has a health check configured, poll it for a configurable
  window (default 60 s) using the existing `healthChecker`.
- Pass: record the revision as `active`, as today.
- Fail (D2): record it as a new status, `unhealthy` (needs PR 2 to change the `CHECK`
  constraint), notify, and leave containers running. The previous `active` row is
  superseded, because the unhealthy revision is what is actually running.
- **Optional per-project toggle:** "Roll back automatically when the health check
  fails", which runs `rollbackProject` with the default target.
- Projects without a health check keep today's behavior, with a hint in the UI that
  deploys are not verified.

**Deployed installs:** no behavior changes until a project has a health check *and*
the deploy runs on the new version. Auto-rollback is off for every project until
enabled (D2).

**Tests:** health pass, health fail without auto-rollback, health fail with
auto-rollback, no health check configured.

### PR 5 — One deploy-history table (T2)

**Problem:** `project_deploys` (auto-deploy commit metadata) and `project_deployments`
(revisions for rollback) overlap. Every auto-deploy writes both.

**Approach (safe for existing data):**
- Add `commit_message`, `commit_author`, `completed_at` and a `running` status to
  `project_deployments` via a migration.
- New deploys write one row only.
- Existing `project_deploys` rows are left in place and shown read-only until they age
  out of retention. A later release drops the table. No attempt to match and merge old
  rows, which would be guesswork.
- The Deployments card shows one list instead of two.

---

## Phase 2: MCP with token authentication

The existing stdio server (`src/mcp/server.ts`) stays as it is. The new server runs
**inside the Stackport process**, so it shares the per-project action lock and never
writes to the database from a second process.

### PR 6 — API tokens and read-only MCP over HTTP (MCP-1, S5 part)

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

### PR 8 — Action runner, server side (RUN-1)

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

**Tests:** sequence replay with no duplicates or gaps across attach, masking, retention
pruning, deletion paths, interrupted-on-startup.

### PR 9 — Data layer foundation and runner client (T5a, RUN-2)

Adopt TanStack Query (D3).

- Provider, a query-key factory (`['projects']`, `['project', id]`,
  `['project', id, 'deployments']`, `['actions']`), and one socket bridge that turns
  events into cache updates.
- Move the projects list and project detail to queries.
- On connect, read the running-actions list: every running action gets a toast or dock
  entry, whoever started it and whenever.
- One `<ActionLog actionId>` component replacing the current three log paths; it keeps
  the last seen sequence number in `sessionStorage` to resume after a reconnect.

### PR 10 — Data layer: remaining pages (T5b)

Migrate the remaining pages and contexts page by page, deleting their hand-written
fetch/state code as each one moves.

### PR 11 — Data layer cleanup (T5c)

- Delete `pollProjectAction` and `SystemContext`'s store.
- Lower the global rate limit from 1000 per 15 minutes once polling is gone, sized from
  measured traffic.

---

## Phase 4: product cleanup

### PR 12 — Webhooks first, poller as fallback (R3)

Webhook deploys already exist (`0f05f63`). Remaining:
- New projects default to the `webhook` trigger when the app has an HTTPS domain
  (webhooks require HTTPS).
- If a project's webhook status is `failing`, or has been `waiting` for longer than a
  set time, the poller covers it and the UI says so.
- Existing projects keep their current trigger.

### PR 13 — Remove the Hostinger feature (R1)

Not used on any deployed install (D1). Remove the UI, routes and services (about 1,600
lines). Stored Hostinger API key credentials stay in the credentials list for the
admin to delete. Keep the database tables for one release; a later migration drops
them, so a rollback to the previous version still finds its schema.

### PR 14 — Label the traffic window (R2)

Insights traffic reads at most 20,000 recent nginx log lines, and history resets when
the container is recreated. Show the time range actually covered next to the period
picker, and say when the chosen period is longer than the data.

### PR 15 — Safer destructive actions, env paste (U2, U5)

- Type the project name to confirm Stop & Delete Data, Drop volumes and Delete project.
- Env manager: paste a whole `.env` at once; flag `${VAR}` references in the Compose
  file that no managed env file defines.

---

## Phase 5: UI structure

### PR 16 — Project page as routed tabs (T4)

Split `ProjectDetails.tsx` (about 1,840 lines, 68 `useState`) into
`/projects/:id/{overview,deployments,domains,env,logs,settings}`. Each tab owns its
queries (after PR 9, mostly moving code). `/projects/:id` redirects to overview, and
existing query parameters such as `?setup=` keep working.

### PR 17 — Navigation consolidation (U1)

From System, Infrastructure and Settings → Infrastructure overlapping, to:
**Projects · Insights · Logs · Host** (Docker, nginx, certificates, hardware)
**· Settings** (general, deploy triggers, notifications, credentials, MCP, maintenance).
Every old route redirects.

### PR 18 — Deploy and rollback preview (U3)

Before a deploy: the commits between the running revision and the target. Before a
rollback or restore: the same, plus a diff of the effective Compose files. The
revision picker itself shipped in PR 1.

### PR 19 — Clear policy-violation display (U4, part)

Show Compose policy rejections as a list (service, key, how to fix) instead of raw log
text. The volume-mapping display waits for the volume-model redesign (deferred S2).

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
| N1 `/version.json` exposes the exact commit without auth | ⚪ | |
| A1 Deploy prebuilt images by digest | 🟡 | Needs S1 |
| A2 Scheduled off-host backups | 🟠 | |
| A3 Build before `up`, blue-green | ⚪ | |

**Until S1 and S2 land:** turn off auto-deploy for any repository that someone other
than the admin can push to.
