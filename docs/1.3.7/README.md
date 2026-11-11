# Stackport 1.3.7

Branch `1.3.7`, from `main` after 1.3.5. Release order: **1.3.1** (done) → **1.3.5** (done) → **1.3.7** → **1.4**. There is no 1.3.6.

1.3.7 was planned as two features, the GitHub App and the domain manager. It now also carries the follow-ups that 1.3.5 listed but did not build (G2 to G4 and P2 to P8 of the [1.3.0 postmortem](../1.3.5/postmortem-1.3.0-ingress-networks.md)). The **domain manager is not built** ([domain-manager.md](domain-manager.md)).

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
| GitHub App A to D | Register from a manifest, link installations, installation tokens, repository discovery, the Git credential resolver, the App in the wizard, PAT to App migration, the signed webhook with durable deliveries and replay, credential rotation ([github-app-operations.md](github-app-operations.md)) | tests against an in-process fake of GitHub. **Not run against github.com** |

P1 (regression report and restore point) and the database backup stay in 1.4 ([../1.4/README.md](../1.4/README.md)).

## Not done

- **The domain manager** (#389 to #393).
- **GitHub App modules M1 to M3** beyond requesting their permissions: reporting deploys to GitHub, deploying only after CI, deploying a release or tag. Also bulk import, MCP tools for repositories, and pull-request previews (waits for S11).
- **A real-GitHub check of the App**, and a **real staging-host pass** of the networking changes. Both are named in the pull request.

## Before merging

- Have the staging host ready: the manifest flow needs a public HTTPS domain, and webhooks need to reach it.
- Run the rows of [../1.3/verification.md](../1.3/verification.md) that the networking changes touch (S9 and S15 especially), and the new Domains > Routing and Network isolation on a copy of a real install.
- **Switch isolated projects back to the shared network before `stackport rollback`** ([network-isolation.md](network-isolation.md)), and move App projects back to a token.

Working On It: GitHub App #368 to #371; domain manager #389 to #393.
