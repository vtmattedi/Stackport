# Stackport 1.3.5

Branch `1.3.5`, started from `1.3` (PR #33, not merged yet). Three jobs:

1. **Inventory** what 1.3 missed, deferred or left unverified.
2. **GitHub App** integration, from [../1.3/github-app.md](../1.3/github-app.md).
3. **Leftovers**: remove what 1.3 left behind.

Ratings follow [../1.3/README.md](../1.3/README.md): 🔴 fix first, 🟠 soon, 🟡 worth doing, ⚪ housekeeping. Sizes: S, M, L, XL.

If PR #33 is squash-merged, this branch needs a rebase onto `main` first.

**Incident:** 1.3.0 took routed projects down on 7 November 2026 when per-project networks exhausted Docker's address pool; fixed by 1.3.1. See [postmortem-1.3.0-ingress-networks.md](postmortem-1.3.0-ingress-networks.md). Its open follow-ups (P1 to P8) belong to this release. P1 is a regression report plus a restore point and Restore action, not an automatic rollback.

## 1. Inventory: what 1.3 missed

### Found while checking, not in any plan before

| ID | Item | | Size | Notes |
|---|---|---|---|---|
| G1 | The Git token travels in process arguments (**done**, see [../1.3/security.md](../1.3/security.md)) | 🟠 | M | `git -c http.extraHeader=Authorization: …` (`deployments/operations.ts` `gitAuthHeader`, also `maintenance/version.ts`). Anyone who can list processes on the host reads it. Replace with environment-based `GIT_CONFIG_*` or a credential helper. Required by the GitHub App work anyway (its §4.1), so it is Phase B below. |
| G2 | No way to enforce the Compose policy on an existing project | 🟠 | S | 1.3 enforces new projects only (`compose_policy_enforced = 0` for older ones). `security.md` S1 says "add one before the next release"; nothing sets it. Same for `volumes_managed` (only the temporary migration sets it). Needs a per-project switch and a Settings view of which projects are still unenforced. |
| G3 | The policy panel misses the resolved-config results | 🟡 | S | The project page shows raw-file violations; the resolved checks (S1) only appear when a deploy is rejected. |
| G4 | Lint warnings grew from 110 to 207 | ⚪ | M | B5 below; the 1.3 work added ~100. Fix or justify, then make warnings fail CI. |

### Deferred by decision in 1.3

| ID | Item | | Size | Notes |
|---|---|---|---|
| S10 | Block cloud metadata and LAN egress | 🟡 | M | `DOCKER-USER` rules from `stackport.sh`; needs a Linux host to test. Plan in `security.md`. |
| S11 | Docker socket containment | 🟠 | XL | No design chosen. Anyone with code execution in the Stackport container has root on the host. Needs its own decision first. |

### Backlog carried over ([../1.3/backlog.md](../1.3/backlog.md))

| ID | Item | | Size |
|---|---|---|---|
| A2 | Scheduled off-host backups | 🟠 | M |
| MCP-2 | OAuth for claude.ai connectors | 🟡 | L |
| A1 | Deploy prebuilt images by digest (S1 is done, so unblocked) | 🟡 | M |
| U4b | Show volume mappings on the project page (S2 is done, so unblocked) | 🟡 | S |
| A3 | Build before `up`, blue-green | ⚪ | L |
| B1 | Pin the rollback target from the preview | ⚪ | S |
| B2 | Upstream keepalive in the nginx proxy blocks | ⚪ | S |
| B3 | Bound the GitHub ETag cache | ⚪ | S |
| B4 | Palette: deploy a chosen branch | ⚪ | S |
| B6 | `Stackport.md` for 1.2's behaviour changes (and now 1.3's) | ⚪ | S |
| B8 | Delete merged remote branches | ⚪ | S |
| N1 | `/version.json` exposes the exact commit without auth | ⚪ | S |

### Built in 1.3 but never run against a real host

Everything in [../1.3/verification.md](../1.3/verification.md). The ones that matter most, because a mistake costs data or access:

- mount copy, its `diff` verification and the cleanup check (S2)
- per-project ingress networks and nginx reconnecting after a recreate (S9)
- network groups: `getent hosts db.p<id>` from another project (S15)
- the session cookie over HTTPS, and sockets closing with the session (S6)
- key rotation and the re-encryption migration (S7)
- the `build` policy check and the file-reference checks inside a real container (S1)

A single pass on a staging host closes all of these. Task #287 already holds the 1.2 half of this list.

### Working On It board is out of date

#270 (S9) was built but still `todo`. S15 (network groups), the MCP network tools, both review rounds and the build/socket/cleanup/restart/seed fixes had no tasks. Brought up to date on 2026-11-07: #270 done, #376 and #377 added as done, the 1.3.5 tasks added as #367 to #375, and comments on #282 and #287.

## 2. GitHub App

Plan: [github-app.md](github-app.md) in this folder (it replaces the phases and storage choices of [../1.3/github-app.md](../1.3/github-app.md), which stays as the security reference). Design: each Stackport instance registers its own GitHub App through the App Manifest flow; installation tokens replace PATs; one signed webhook endpoint on the instance. Four phases; this branch builds A to C and the testable part of D.

| Phase | Delivers | Needs a real GitHub account? |
|---|---|---|
| A | App registration (manifest flow), secrets storage, JWT and installation tokens, installation linking, repository discovery, Settings > GitHub connections | Yes, to create the App; everything before that is testable with a fake GitHub |
| B | Git credential resolver (no token in process arguments, **G1**), App source in the new-project wizard, PAT to App migration | Yes, for the clone |
| C | Signed webhook receiver, durable delivery table, dedupe and replay, installation and repository events, status in the UI | Yes, for real deliveries |
| D | Hardening, rollback and upgrade tests, key rotation and recovery docs | Partly |

Order of work inside the branch: **G1** first (it is a fix on its own and unblocks B), then A, B, C.

Settled defaults from §12 of the plan, unless you say otherwise:

- the first release links installations to the single admin; no multi-user model
- delivery payloads kept for 14 days and 256 KB each, failed ones for 30
- new projects default to the App once one is configured; existing PAT projects change only when someone migrates them
- GitHub API calls: at most 2 at a time per instance, with backoff on 403 and 429

**Security gate** (plan §9): S14, S1, S2 and S12 are done, so App projects no longer need the "trusted repositories only" limit for those reasons. S11 (socket containment) is not done, so a repository still controls what runs; say so in the UI when connecting an App.

## 3. Leftovers to clear

| ID | Item | Size | Notes |
|---|---|---|---|
| L1 | Remove the vestigial `stackport-proxy` network | S | Projects stopped using it in S9. Still declared in `docker-compose.system.yml`, created and removed in `stackport.sh`, the constant `STACKPORT_PROXY_NETWORK` is only used to strip it from old Compose files, and two comments describe it as current. Keep the strip-from-old-files code for one more release, drop the rest. Needs care: `stackport update` on an existing host must not fail when the network is gone. |
| L2 | Stale comments and names | S | 32 comments say "Phase 1.7"; `ensureProjectProxyNetwork` and `applyStackportProxyNetwork` now mean the ingress network; two doc comments name a file that no longer exists (`composeNetworking.ts`). |
| L3 | `docs/plan.md` repeats the 1.3 security table | S | Out of date the day it was written (S9 and S15 changed). Point it at `docs/1.3/` instead of keeping two copies. |
| L4 | Delete `docs/deprecated/` (B7) | S | Nothing in it is current. |
| L5 | Temporary migrations page | S | Stays through 1.3.x so installs can migrate. Remove it (`src/modules/maintenance/migrations`, `client/src/pages/settings/migrations`, the TEMPORARY lines) in the first release after every install has run it. Decide the release now. |
| L6 | Lint warnings (G4/B5) | M | |
| L7 | Compat shims from the modular layout | | Main owns `src/routes`, `src/utils`, `src/middleware`, `src/mcp`, `src/entities`. Not ours; left alone unless main removes them. |
| L8 | Version | S | Reported version is 1.3.0. Bump to 1.3.5 with `scripts/bump-version.cjs` when this branch is ready to release, not before. |
