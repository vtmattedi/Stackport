# Stackport 1.3.7

Branch `1.3.7`, from `main` after 1.3.5. Release order: **1.3.1** (done) → **1.3.5** (done) → **1.3.7** → **1.4**. There is no 1.3.6.

1.3.7 was planned as two features, the GitHub App and the domain manager. It now also carries the follow-ups that 1.3.5 listed but did not build (G2 to G4 and P2 to P8 of the [1.3.0 postmortem](../1.3.5/postmortem-1.3.0-ingress-networks.md)). The **domain manager** ([domain-manager.md](domain-manager.md)) and the **GitHub App modules M1 to M3, bulk import and the MCP repository tools** are built too.

## What is built

| ID | Item | Verified how |
|---|---|---|
| G1 | The Git token is out of process arguments | done in 1.3.5 |
| G2 | A per-project Compose-policy switch, and Settings > Project protections listing projects still missing the policy, managed volumes or hardened defaults. Managed volumes have no plain switch on purpose: turning them on without copying the data would start a project on an empty directory, so Migrations stays the way | unit tests |
| G3 | The project's policy panel also shows the problems found after Compose resolves the file, and says when it could not be resolved | typecheck and build only; no test of the resolved path (it runs `docker compose config`) |
| G4 | Zero lint warnings and CI fails on any; every remaining security-rule warning has a reason on the line or at the top of the file (the regular expressions were measured). Found and fixed on the way: names from a Compose file or the access log could shadow object internals (a service called `__proto__` was left out of the hardening override) | unit tests |
| P2 | Ingress health per project: Domains > Routing, and `stackport_get_project_ingress_health` over MCP | unit tests, and the probe script run against `nginx:1.27-alpine` (reachable, refused and unresolved; the timeout branch is unit-tested only) |
| P3 | Docker network headroom: System page notice, `GET /api/system/network-headroom`, a start-up warning, a line in `stackport status` and at the start of `stackport update` | unit tests and the clean-install run on a real daemon |
| P4 | Warnings and errors also go to the console, so `docker logs` shows them; the stray `console` calls go through the logger | unit tests and the clean-install run |
| P5 | The clean-install test fills Docker's address pool, then updates | the clean-install run (Docker-in-Docker) |
| P6 | A pull request that touches networks, mounts, nginx or start-up must say it was run on a real host ([../staging-gate.md](../staging-gate.md)) | the script's logic only; the workflow has not run on GitHub yet |
| P7 | Per-project network isolation, opt-in, with a subnet from Stackport's own range and a switch that checks the new route from inside nginx first ([network-isolation.md](network-isolation.md)) | unit tests and the clean-install run (switch, nginx recreated, switch back) |
| P8 | The operator runbook ([../runbook.md](../runbook.md)) | read against the code; not exercised |
| Domain manager D1 to D5 | Base domains with one default, hostnames as a label (or the bare domain, with `www` either way), adoption of existing hostnames, a hostname reserved for each new project and routed when there is one port, a safe rename, a new project routed only to a base domain or a subdomain of one, expiry and renewal-failure notifications, MCP tools (no DNS checks: they were removed) ([domain-manager.md](domain-manager.md)) | unit tests; **no certificate issued for an auto-assigned hostname** |
| GitHub App A to D | Register from a manifest, link installations, installation tokens, repository discovery, the Git credential resolver, the App in the wizard, PAT to App migration, the signed webhook with durable deliveries and replay, credential rotation ([github-app-operations.md](github-app-operations.md)) | tests against an in-process fake of GitHub. **Not run against github.com** |

| GitHub App M1 to M3, import, MCP | Report each deploy to GitHub; deploy after CI passes or on a published release; scan and import repositories; list repositories and create a project from one over MCP ([github-app-operations.md](github-app-operations.md)) | tests against the fake of GitHub. **Not run against github.com** |

P1 (regression report and restore point) and the database backup stay in 1.4 ([../1.4/README.md](../1.4/README.md)).

## Not done

- **Pull-request previews** (GitHub App module M4, waits for S11) and **naming rollbacks by tag**.
- **Real-world checks**: the GitHub App against github.com, the domain manager with a real certificate, and a
  **staging-host pass** of the networking changes. All are named in the pull request.
- Whether the new notification types (`certificate_expiring`, `certificate_renewal_failed`) arrive in a browser has not been tried.

## Before merging

- Have the staging host ready: the manifest flow needs a public HTTPS domain, and webhooks need to reach it.
- Run the rows of [../1.3/verification.md](../1.3/verification.md) that the networking changes touch (S9 and S15 especially), and the new Domains > Routing and Network isolation on a copy of a real install.
- **Switch isolated projects back to the shared network before `stackport rollback`** ([network-isolation.md](network-isolation.md)), and move App projects back to a token.

Working On It: GitHub App #368 to #371; domain manager #389 to #393.
