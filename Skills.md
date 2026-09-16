---
name: stackport
description: Adapt Docker Compose projects for deployment on Stackport. Use when preparing, validating, or deploying a repository to Stackport.
---

# Stackport Deployment Preparation Skill

Use this guide when preparing an application repository to deploy on Stackport.

Stackport deploys one GitHub repository (or a manually-uploaded compose file) as one project. It clones the repo, writes configured `.env` files, runs Docker Compose from the repo root, joins the relevant service(s) to its own reverse-proxy network, and routes one or more domains to them through its own nginx — issuing Let's Encrypt certificates as needed. Prepare the project so this flow is boring and repeatable.

## The one invariant that matters most

**Managed applications never publish a host port.** No `ports:`, no `network_mode: host`. Stackport rejects a compose file that does either, at deploy time, with a specific error — it does not silently rewrite your file to make it "safe." Use `expose:` for whichever container-internal port needs to be reachable, and let Stackport route a domain to it. Stackport decides what the VPS exposes publicly; the application being deployed doesn't get a vote.

## Preparation Workflow

1. Inspect the app stack and identify how it starts in production.
2. Add or repair a root-level `docker-compose.yml` or `compose.yml`.
3. Ensure the app listens on `0.0.0.0` inside the container, not only `127.0.0.1`.
4. Use `expose:` (not `ports:`) for the container-internal port the web entrypoint listens on. Never add `network_mode: host`.
5. Move runtime configuration to environment variables or a safe `.env` file path.
6. Add a fast health endpoint when the app does not already have one.
7. Validate Docker Compose locally before asking Stackport to deploy it.
8. Produce the Stackport onboarding fields and any env-file variables the operator must set.

## Compose Requirements

Stackport only understands Docker Compose at the repository root. Prefer this shape:

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    expose:
      - "3000"
```

The app must serve plain HTTP on the exposed container port. Stackport's nginx handles HTTPS and certificate renewal, and reaches this service by its Compose service name over Stackport's internal Docker network — not by any host-published port.

Use named volumes for persistent runtime data. Avoid bind mounts to machine-specific local paths unless the project explicitly requires host files — and avoid mounting sensitive host paths (`/`, `/etc`, the Docker socket, etc.); Stackport's compose policy rejects those outright.

Multiple services can be exposed and routed independently — e.g. a public frontend on one domain and an internal API on another, both from the same compose file. Each domain registered in Stackport names exactly one `(service, container port)` pair.

Do not require ports below `1024` inside the container. Do not expose databases publicly unless the user explicitly asks for that and understands the risk — and even then, it goes through Stackport's routing, never a published host port.

## Environment Files

Do not commit real secrets. If the app needs secrets, make the app read environment variables and tell Stackport which `.env` file to write.

Stackport env-file paths must:

- End in `.env`.
- Be relative to the repository root.
- Not contain `..` or start with `/`.
- Be 240 characters or fewer.

Variable keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values cannot contain newlines.

## Health Checks

Prefer a simple HTTP endpoint such as `/health` that returns a `2xx` response quickly without requiring authentication. Keep it well under Stackport's health-check timeout budget (10s).

Good health checks verify the web process is alive. Avoid checks that depend on slow third-party APIs unless the user specifically wants health to fail when that dependency is down.

## Local Validation

Run these from the application repo before onboarding — note there is no host-side port to curl against here, since the whole point is that nothing is published to the host; validate against the container network directly:

```bash
docker compose config
docker compose build
docker compose up -d
docker compose exec <service> curl -fsS http://localhost:<container-port>/<health-path>
docker compose down
```

If the app has no health endpoint, validate the home page or another stable unauthenticated endpoint the same way.

## Stackport Onboarding Fields

Prepare these values:

- **Project**: `name` (display name, ≤100 chars), `groupName` (optional group, e.g. `Mw Control`; null means ungrouped), `githubRepo` (`owner/repo`), `githubCredentialId` (private repos only), `autoDeployBranch` (branch to poll for auto-deploy).
- **Per domain**: `domain` (valid FQDN, unique across the host), `service` (must match a service name that actually exists in the project's compose file), `containerPort` (the declared container port), `useSsl`. After pulling/uploading the project and configuring env files, choose the detected `service:port` from the existing select component. Detection reads resolved `docker compose config --format json`: TCP `expose`/port targets, with `PORT` or `HTTP_PORT` as a fallback. Host-published `ports` remain prohibited by deployment policy.
- **Optional**: `healthCheckEndpoint` (path like `/health`), `healthCheckIntervalS` (0 disables checks; use 30s or longer for routine monitoring).

Do not configure the legacy `internalPort` field — a project can route multiple domains to different services/ports, and nothing is ever published to the host regardless.


## Installing and operating Stackport itself

On a fresh VPS, point the admin domain at the server and allow SSH, HTTP/80 and HTTPS/443. Run `stackport.sh install`; it installs Docker and missing curl/git/openssl prerequisites, generates configuration and bootstrap credentials, and waits for admin HTTPS before reporting success. Enter the printed bootstrap credential in the browser and set the administrator identity.

Nginx always runs in `stackport-nginx`. Certbot runs in temporary containers for issuance and automatic renewal; neither needs a host package, systemd service, nor a runtime toggle. System status comes from Docker. Certificates stay under `/etc/letsencrypt`, and ACME files under `/var/lib/stackport/certbot-webroot`; preserve the system Compose mounts rather than changing generated nginx files or private-key permissions.

Use `stackport update` for source updates and system-stack reconciliation. Traffic reads Docker's nginx stdout logs (including domain and request time), with bounded retention. Groups organize projects in the navigation submenu; they do not change routing or Compose isolation.

## Interacting with a running Stackport instance

If you have MCP access to a Stackport host, its tools are self-documenting (titles/descriptions/annotations on each tool, plus a `stackport://skills/project-prep` resource serving this same guide) — inspect what's available at call time rather than relying on a fixed sequence written here, since tool names/parameters can change independently of this document. The two things worth stating explicitly:

- Stop before deploying if compose validation fails, required secrets are missing, or the target domain doesn't actually point at this host.
- Never request or display the plaintext value of a stored credential/secret — every relevant tool redacts values by design; respect that redaction rather than working around it.

If you don't have MCP access, the same preparation work still applies — an operator can create the project and domains by hand in the Stackport UI using the fields above.

## Final Handoff

When you finish preparing a repo, summarize:

- Files changed.
- The chosen Stackport fields (project + per-domain routing).
- Required env variables and which `.env` path Stackport should write.
- Validation commands run and their results.
- Any remaining manual steps such as DNS, GitHub credentials, or SSL issuance.
