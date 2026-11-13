# Stackport

Stackport is a self-hosted control plane for running several Docker Compose projects on
one server. It deploys projects from GitHub or an uploaded Compose file, routes domains
to them through its own nginx container, issues Let's Encrypt certificates, and shows
logs, resource usage and traffic, all from one web UI.

**[Project website](https://stackport.mattediworks.com/)** ·
**[Technical overview](Stackport.md)** · **[Deployment guide](.agents/skills/stackport/SKILL.md)**

Stackport runs entirely in Docker. The host needs Docker and the `stackport` management
CLI; nothing else is installed on it.

## Problem and scope

Operating several applications on one VPS usually means maintaining separate
Docker Compose projects alongside reverse-proxy rules, certificates, deployment
scripts, and troubleshooting procedures. Stackport provides a single control
plane for these recurring operations while keeping each application as an
independent Compose project.

The intended scope is a trusted, single-operator VPS, not a multi-node
orchestrator or a security boundary for mutually untrusted tenants. Applications
retain responsibility for their own configuration, data, and security.

## Architecture and design decisions

Backend source is grouped by capability; see the [backend module map](docs/backend-modules.md)
for ownership, import rules, and compatibility paths.

**Separate management and workload stacks.** Stackport and its nginx proxy run
in a dedicated Compose project; each managed application runs in its own Compose
project. This keeps management lifecycle operations separate from application
deployments, but all workloads still share the host's Docker engine.

**Centralize public ingress.** Managed Compose files cannot publish host ports.
Stackport connects routed services to a shared Docker proxy network and maps
HTTP domains to their internal service ports. Explicit raw TCP exposures use
Stackport-owned forwarding containers. This provides one place to manage
exposure, at the cost of restricting Compose configurations and requiring
applications to handle their own TLS for raw TCP.

**Record reproducible deployments.** GitHub deployments resolve to specific
commits and preserve the effective Compose configuration, making application
revisions traceable and allowing earlier revisions to be redeployed. This is
not a data rollback: database migrations and persistent volumes remain the
application's responsibility.

**Validate Compose before deployment.** Stackport rejects privileged
containers, host networking, dangerous bind mounts, and other unsafe settings
rather than silently rewriting them. The policy reduces accidental host
exposure, but does not provide isolation against hostile workloads.

**Keep host recovery independent of the web UI.** A host-level CLI handles
installation, updates, rollback, repair, and administrator recovery. The UI
handles routine deployment, logs, monitoring, and traffic inspection. This
separation allows recovery even when the application UI is unavailable.

See the [technical overview](Stackport.md) for implementation details and
operational constraints.

## Releases and updates

Stackport separates development from the versions offered to installed servers.
Changes land on `main`, where GitHub Actions runs CI and upgrade scenarios.
The upgrade suite starts from the current `stable` revision and tests CLI and
in-app updates, failed builds and runtimes, and rollback against a newer database.
Only after both checks pass does the promotion workflow fast-forward `stable`.

New installations and `stackport update` follow `stable` by default; an operator
can explicitly configure a different branch. Promotion does not update running
servers automatically. During an update, the host CLI backs up its database,
checks the replacement's health and rolls back if the update fails.

See [promotion](.github/workflows/promote.yml),
[upgrade scenarios](.github/workflows/upgrade.yml), and the
[host lifecycle details](Stackport.md#2-installation-and-host-lifecycle--stackportsh).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vtmattedi/Stackport/main/stackport.sh -o stackport.sh
chmod +x stackport.sh
sudo ./stackport.sh install
```

The installer asks for an optional domain (leave it blank to use the server's IP with a
self-signed certificate) and prints a one-time login. Open the app over HTTPS and
follow the setup screen to create the admin account.

Day-to-day host commands: `stackport update`, `stackport rollback`, `stackport status`,
`stackport repair`, `stackport admin-recovery`, `stackport uninstall`.

## Preparing a project

Projects are deployed with `docker compose`. Services must use `expose:` for the port
they listen on, never `ports:`. Stackport decides what is public and routes a domain to
a `service:port`. Host networking, privileged containers and dangerous bind mounts are
rejected. See [`.agents/skills/stackport/SKILL.md`](.agents/skills/stackport/SKILL.md) for the full checklist.

## Documentation

- [`Stackport.md`](Stackport.md): architecture, install and host lifecycle, security
  model, and how deploys, rollback, nginx and certificates work.
- [`.agents/skills/stackport/SKILL.md`](.agents/skills/stackport/SKILL.md): the agent skill for preparing a repository for deployment (also exposed as an MCP resource).
- [`docs/plan.md`](docs/plan.md): development plan and historical implementation notes.
- [`docs/1.4/README.md`](docs/1.4/README.md): planned three-level backup/restore, Stackport Control between peers, and two-VPS validation.
- [`docs/1.5/README.md`](docs/1.5/README.md): future update regression/restore-point work; scheduled off-host backups remain a deferred candidate.

## Development

```bash
npm ci && npm ci --prefix client
npm run dev          # API on :3000 and the Vite client, with reload
npm test             # API tests
npm run typecheck && npm run lint
npm --prefix client run build:dry
```

Pull requests run the same checks in CI (`.github/workflows/ci.yml`). Database schema
changes go in `src/migrations/` and may only add to the schema, because
`stackport rollback` runs older code on the migrated database.
