# Stackport

Stackport is a self-hosted control plane for running several Docker Compose projects on
one server. It deploys projects from GitHub or an uploaded Compose file, routes domains
to them through its own nginx container, issues Let's Encrypt certificates, and shows
logs, resource usage and traffic, all from one web UI.

**[Project website](https://stackport.mattediworks.com/)** ·
**[Technical overview](Stackport.md)** · **[Deployment guide](Skills.md)**

Stackport runs entirely in Docker. The host needs Docker and the `stackport` management
CLI; nothing else is installed on it.

## Why I built it

I was managing several applications on a VPS using Docker Compose, nginx and Let's
Encrypt. Each application meant repeating deployment, domain, certificate and
troubleshooting work. I built Stackport to bring those operations into one place
without giving up direct control of the server.

Stackport is intentionally focused on managing multiple applications on a single VPS,
not replacing Kubernetes or becoming a general-purpose cloud platform. I use it to
operate MattediWorks services, including my personal site.

## How Stackport works

Stackport runs alongside the applications it manages, but keeps its own infrastructure
separate. The management application and nginx reverse proxy belong to a dedicated
Docker Compose project, while each deployed application runs as an independent
Compose project.

Networking is managed centrally. Applications do not publish ports directly on the
host; instead, Stackport connects routed services to a shared proxy network and maps
domains to their internal ports. Explicitly configured raw TCP exposure uses
Stackport-managed proxy containers. This keeps public exposure under Stackport's
control rather than individual Compose files.

Deployments from GitHub are tied to specific commits, so Stackport can track which
revision is running and redeploy an earlier recorded revision. Deployment history also
retains the resolved Compose configuration. Rolling back application code does not
automatically restore application data or reverse database migrations.

Because Stackport manages infrastructure, it validates Compose configurations before
deployment and rejects settings such as privileged containers, host networking and
dangerous bind mounts. These restrictions reduce accidental exposure and unsafe
configurations; they are not complete isolation for hostile workloads.

A host-level CLI handles installation, updates, repair and recovery. The web
interface provides day-to-day deployment controls, container logs, resource
monitoring and HTTP traffic information.

For the implementation details and design constraints, see the
[technical overview](Stackport.md).

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
rejected. See [`Skills.md`](Skills.md) for the full checklist.

## Documentation

- [`Stackport.md`](Stackport.md): architecture, install and host lifecycle, security
  model, and how deploys, rollback, nginx and certificates work.
- [`Skills.md`](Skills.md): preparing a repository for deployment.
- [`docs/plan.md`](docs/plan.md): the current improvement plan.

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
