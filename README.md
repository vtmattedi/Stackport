# Stackport

Stackport is a self-hosted control plane for running several Docker Compose projects on
one server. It deploys projects from GitHub or an uploaded Compose file, routes domains
to them through its own nginx container, issues Let's Encrypt certificates, and shows
logs, resource usage and traffic, all from one web UI.

Stackport runs entirely in Docker. The host needs Docker and the `stackport` management
CLI; nothing else is installed on it.

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
