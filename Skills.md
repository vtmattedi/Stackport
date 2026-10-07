---
name: stackport
description: Adapt Docker Compose projects for deployment on Stackport. Use when preparing, validating, or deploying a repository to Stackport.
---

# Stackport Deployment Preparation Skill

Use this guide when preparing an application repository to deploy on Stackport.

Stackport deploys one GitHub repository (or a manually uploaded Compose file plus support files) as one project. It clones or stages the project, writes configured `.env` files, runs Docker Compose from the project root, and joins routed services to its `stackport-proxy` network. HTTP traffic is routed through Stackport's nginx with optional Let's Encrypt certificates. Generic TCP traffic is routed through Stackport-owned TCP proxy containers without protocol inspection or TLS termination. Prepare the project so this flow is boring and repeatable.

## The one invariant that matters most

**Managed applications never publish a host port.** No `ports:`, no `network_mode: host`. Stackport rejects a compose file that does either, at deploy time, with a specific error — it does not silently rewrite your file to make it "safe." Use `expose:` for each reachable container port, then configure either an HTTP domain route or a raw TCP exposure in Stackport. Stackport alone owns host-side listeners and decides what the VPS exposes publicly.

## Preparation Workflow

1. Inspect the app stack and identify how it starts in production.
2. Add or repair a root-level `docker-compose.yml` or `compose.yml`.
3. Ensure the app listens on `0.0.0.0` inside the container, not only `127.0.0.1`.
4. Use `expose:` (not `ports:`) for every HTTP or TCP container port Stackport must reach. Never add `network_mode: host`.
5. Move runtime configuration to environment variables or a safe `.env` file path.
6. For HTTP apps, add a fast health endpoint when one does not already exist. For TCP-only apps, add a Compose container health check and plan an external protocol-aware check.
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

GitHub projects may select any top-level `.yml`/`.yaml` file; default selection priority is `docker-compose.stackport.yml`, then `docker-compose.yml`, then the alphabetically first top-level YAML file. Manual upload requires `docker-compose.yml` or `docker-compose.yaml` and accepts up to 30 small support files (5 MiB maximum per file), preserving their safe relative paths.

Web entrypoints normally serve plain HTTP on their exposed container port. Stackport's nginx handles public HTTPS and certificate renewal, and reaches the selected service over Stackport's internal Docker network — not by any host-published port.

Non-HTTP services declare TCP ports with `expose:` and use an explicit Stackport TCP exposure. Stackport publishes the selected host port through a Stackport-owned `stackport-tcp-<id>` proxy container, joins that proxy and the selected project service to `stackport-proxy`, and forwards bytes to `<service>:<containerPort>` unchanged. Stackport does not inspect the protocol, terminate TLS, issue a certificate, authenticate clients, or define application authorization for a TCP exposure. Those responsibilities stay with the project.

Use named volumes for persistent runtime data. Relative project bind mounts are suitable for versioned configuration and scripts. Avoid machine-specific or sensitive host paths (`/`, `/etc`, `/proc`, `/sys`, `/run`, `/var/run`, the Docker socket, etc.); Stackport's compose policy rejects those outright. It also rejects privileged containers, host PID/IPC namespaces, device mappings, and dangerous `cap_add` values (`ALL` and `SYS_ADMIN`).

Multiple services can be exposed and routed independently — e.g. a public frontend on one domain and an internal API on another, both from the same compose file. Each domain registered in Stackport names exactly one `(service, container port)` pair.

Do not require ports below `1024` inside the application container. Do not expose databases publicly unless the user explicitly asks for that and understands the risk — and even then, it goes through a Stackport TCP exposure, never a Compose-published host port.

### HTTP versus raw TCP ownership

| Concern | HTTP domain route | Raw TCP exposure |
|---|---|---|
| Public listener owner | Stackport nginx | Stackport TCP proxy |
| Public port | 80/443 | Operator-selected unique TCP port |
| TLS termination | Stackport nginx | Project service, if TLS is required |
| Certificate lifecycle | Stackport/Let's Encrypt | Project/operator |
| Application target | `service:containerPort` | `service:containerPort` |
| Protocol visibility | HTTP-aware reverse proxy | Opaque byte stream |
| Stackport health monitor | HTTPS URL on the project's selected health-check domain | Not supported; use container health checks/external monitoring |

For TLS protocols such as MQTTS, SMTPS, or a TLS database endpoint, mount or initialize the certificate inside the project and make the service itself listen with TLS. The TCP proxy must remain passthrough; do not configure an HTTP domain or expect nginx/Certbot to secure that stream. Stackport's HTTP certificates under `/etc/letsencrypt` are system-plane assets and are not mounted into managed projects. Deliver TCP-service certificates through project-owned, policy-compliant configuration (for example, Stackport env files plus an init service and named volume). DNS is still the operator's responsibility and should point the protocol hostname at the Stackport host.

## Environment Files

Do not commit real secrets. If the app needs secrets, make the app read environment variables and tell Stackport which `.env` file to write.

Stackport env-file paths must:

- End in `.env`.
- Be relative to the repository root.
- Not contain `..` or start with `/`.
- Be 240 characters or fewer.

Variable keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values cannot contain newlines.

The API's JSON request limit is 10 KB. For large one-line values such as base64-encoded PEM material, use several Stackport env files and keep every individual save request below that limit. Stackport has no generic "copy this file into a named volume" feature. A project that must be initialized entirely through Stackport can use a one-shot init service to decode one-line env values into a named volume, then gate the main service with `depends_on: condition: service_completed_successfully`. Make env-file references optional at Compose-parse time when target discovery must work before the operator has created them, but make the init script fail closed when required values are absent.

Env-file values are stored in Stackport's database and written as plaintext env files into the project checkout before Compose actions. They are redacted from MCP/read responses, but must still be treated as operational secrets. Never print them in logs or final handoffs, and protect Stackport's database, project files, and backups accordingly.

## Health Checks

Prefer a simple HTTP endpoint such as `/health` that returns a `2xx` response quickly without requiring authentication. Keep it well under Stackport's health-check timeout budget (10s).

Good health checks verify the web process is alive. Avoid checks that depend on slow third-party APIs unless the user specifically wants health to fail when that dependency is down.

Stackport's project health monitor is HTTPS/domain based; it is not a generic TCP probe. Set `healthCheckIntervalS` to `0` for a TCP-only project and use a Compose container health check plus an external protocol-aware check.

When a project has multiple HTTP domains, select the intended domain with `healthCheckDomainId`; Stackport combines that domain with the relative `healthCheckEndpoint`. The first-added domain is selected automatically for compatibility, and removing the selected domain falls back to the next available domain. Because checks use HTTPS, issue and enable SSL for the selected domain before relying on its health result.

Stackport also derives project readiness from the running state of the project's Compose containers. Mark a one-shot or optional helper service so its stopped/exited container does not make the project appear down:

```yaml
services:
  init-certs:
    image: alpine:3.20
    labels:
      com.stackport.health.ignore: "true"
```

The service remains visible in Stackport's Docker views and its logs/actions remain available; the label only excludes it from the project-level container health calculation. Do not apply it to the long-running application, worker, database, or other services whose absence should make the project unhealthy.

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

For a TCP service, replace the `curl` step with a protocol-aware client run inside the Compose network. For TLS passthrough, verify the certificate chain and hostname at the service itself, then repeat through the public Stackport TCP exposure after onboarding.

## Stackport Onboarding Fields

Prepare these values:

- **Project**: `name` (display name, ≤100 chars), `groupName` (optional group, e.g. `Mw Control`; null means ungrouped), and source type. GitHub projects also need `githubRepo` (`owner/repo`), `githubCredentialId` (private repos only), and `autoDeployBranch` (branch to poll for auto-deploy). Upload projects use the UI upload flow instead.
- **Per domain**: `domain` (valid FQDN, unique across the host), `service` (must match a service name that actually exists in the project's compose file), `containerPort` (the declared container port), `useSsl`. After pulling/uploading the project and configuring env files, choose the detected `service:port` from the existing select component. Detection reads resolved `docker compose config --format json`: TCP `expose`/port targets, with `PORT` or `HTTP_PORT` as a fallback. Host-published `ports` remain prohibited by deployment policy.
- **Per TCP exposure**: `publicPort` (unique on the host), `service`, and `containerPort` (a detected declared TCP target). Stackport creates and reconciles the public listener; do not add a Compose `ports:` entry. Raw TCP passthrough does not provide TLS, authentication, or authorization for the application.
- **Optional**: `healthCheckDomainId` (one of the project's domain IDs), `healthCheckEndpoint` (path like `/health`), `healthCheckIntervalS` (0 disables checks; use 30s or longer for routine monitoring).

Do not configure the legacy `internalPort` field — a project can route multiple domains to different services/ports, and nothing is ever published to the host regardless.

For a TCP-only project, configure no HTTP domain. After the project has been pulled/uploaded and its env files resolve successfully, choose a detected target and add the TCP exposure from the project page. Stackport verifies that the service and target port are declared, rejects collisions (including its reserved/system ports and ports already published by containers), persists desired state, and recreates its owned proxy at startup. Removing the exposure removes only that proxy; removing the project removes all of its TCP proxies.


## Installing and operating Stackport itself

On a fresh VPS, point the admin domain at the server and allow SSH, HTTP/80 and HTTPS/443. Run `stackport.sh install`; it installs Docker and missing curl/git/openssl prerequisites, generates configuration and bootstrap credentials, and waits for admin HTTPS before reporting success. Enter the printed bootstrap credential in the browser and set the administrator identity.

Nginx always runs in `stackport-nginx`. Certbot runs in temporary containers for issuance and automatic renewal; neither needs a host package, systemd service, nor a runtime toggle. System status comes from Docker. Certificates stay under `/etc/letsencrypt`, and ACME files under `/var/lib/stackport/certbot-webroot`; preserve the system Compose mounts rather than changing generated nginx files or private-key permissions.

Use Settings > **Update Stackport**, or `stackport update`, for source updates and system-stack reconciliation. The UI starts a detached Docker job and resumes progress after restart; it reports rollback and failures. Traffic reads Docker's nginx stdout logs (including domain and request time), with bounded retention. Groups organize projects in the navigation submenu; they do not change routing or Compose isolation.

## Interacting with a running Stackport instance

If you have MCP access to a Stackport host, its tools are self-documenting (titles/descriptions/annotations on each tool, plus a `stackport://skills/project-prep` resource serving this same guide) — inspect what's available at call time rather than relying on a fixed sequence written here, since tool names/parameters can change independently of this document. The current MCP server supports GitHub-backed project creation, env-file management, ingress-target discovery, HTTP domains, and basic project actions. At the time of this guide, manual project upload and TCP-exposure management are UI/API capabilities and may not have MCP tools. Never invent a TCP tool: if it is absent at runtime, prepare and validate the project, then hand the exact `publicPort -> service:containerPort` values to the operator for the project page.

The other rules worth stating explicitly:

- Stop before deploying if Compose validation fails or required secrets are missing. Before enabling public ingress, verify that each HTTP domain or intended TCP-service hostname actually points at this host.
- Never request or display the plaintext value of a stored credential/secret — every relevant tool redacts values by design; respect that redaction rather than working around it.
- Creating an HTTP domain is not a substitute for creating a TCP exposure. Do not request Let's Encrypt issuance for a raw TCP stream unless the project independently uses that certificate and terminates TLS itself.

If you don't have MCP access, the same preparation work still applies — an operator can create the project, HTTP domains, and TCP exposures in the Stackport UI using the fields above.

## Final Handoff

When you finish preparing a repo, summarize:

- Files changed.
- The chosen Stackport fields (project + each HTTP domain route and/or TCP exposure).
- Required env variables and which `.env` path Stackport should write.
- Validation commands run and their results.
- Any remaining manual steps such as DNS, GitHub credentials, or SSL issuance.
