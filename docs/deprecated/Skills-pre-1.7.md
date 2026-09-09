---
name: stackport
description: Adapt Docker Compose projects for deployment on Stackport. Use when preparing, validating, or deploying a repository to Stackport.
---

# Stackport Deployment Preparation Skill

Use this guide when preparing an application repository to deploy on Stackport.

Stackport deploys one GitHub repository as one project. It clones the repo, writes configured `.env` files, runs Docker Compose from the repo root, proxies a domain to a host port through Nginx, and can issue Let's Encrypt certificates. Prepare the project so this flow is boring and repeatable.

## Preparation Workflow

1. Inspect the app stack and identify how it starts in production.
2. Add or repair root-level `docker-compose.yml` or `compose.yml`.
3. Ensure the app listens on `0.0.0.0` inside the container, not only `127.0.0.1`.
4. Publish exactly one HTTP port for the web entrypoint, using the Stackport `internalPort` as the host-side port.
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
    ports:
      - "3001:3000"
```

In this example, `3001` is the Stackport `internalPort` and `3000` is the container port. The app must serve plain HTTP on the container port. Stackport/Nginx handles HTTPS and certificate renewal.

Use named volumes for persistent runtime data. Avoid bind mounts to machine-specific local paths unless the project explicitly requires host files.

Do not require ports below `1024`. Do not expose databases publicly unless the user explicitly asks for that and understands the risk.

## Environment Files

Do not commit real secrets. If the app needs secrets, make the app read environment variables and tell Stackport which `.env` file to write.

Stackport env-file paths must:

- End in `.env`.
- Be relative to the repository root.
- Not contain `..` or start with `/`.
- Be 240 characters or fewer.

Variable keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values cannot contain newlines.

When using the MCP server, create or replace env files with `stackport_set_project_env_file`. Responses redact values, so keep the user's supplied secret values in the immediate task context only as long as needed.

## Health Checks

Prefer a simple HTTP endpoint such as `/health` that returns a `2xx` response quickly without requiring authentication. Keep it under the Stackport timeout budget of 10 seconds.

Good health checks verify the web process is alive. Avoid checks that depend on slow third-party APIs unless the user specifically wants health to fail when that dependency is down.

## Local Validation

Run these from the application repo before onboarding:

```bash
docker compose config
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:<internalPort>/<health-path>
docker compose down
```

If the app has no health endpoint, validate the home page or another stable unauthenticated endpoint.

## Stackport Onboarding Fields

Prepare these values:

- `name`: Stackport display name, 100 characters or fewer.
- `githubRepo`: GitHub `owner/repo`.
- `internalPort`: unique host port mapped by Compose.
- `domain`: production hostname for Nginx routing and SSL.
- `healthCheckEndpoint`: path like `/health`, or omit if unavailable.
- `healthCheckIntervalS`: use `30` or higher for normal apps.
- `githubCredentialId`: needed for private repos.
- `autoDeployBranch`: branch Stackport should poll for auto-deploys.

For private repos, call `stackport_list_credentials` and choose a GitHub credential ID. Never ask Stackport to expose stored credential secrets.

## MCP Deployment Flow

When connected to the Stackport MCP server:

1. Read `stackport://skills/project-prep` if you need this guide.
2. Call `stackport_status` and `stackport_list_projects` to understand the host.
3. Call `stackport_list_credentials` if the repo is private.
4. Call `stackport_create_project` with the onboarding fields.
5. Call `stackport_set_project_env_file` for each required env file.
6. Call `stackport_inspect_project_repo` to clone/pull and inspect Compose ports.
7. If the inspected ports disagree with `internalPort`, fix the repo or update the project before deploying.
8. Call `stackport_run_project_action` with `action: "deploy"`.
9. If routing fields changed and nginx was not applied, call `stackport_apply_nginx_config`.

Stop before deploying if Compose validation fails, required secrets are missing, the host port conflicts with another project, or the domain points to the wrong server.

## Final Handoff

When you finish preparing a repo, summarize:

- Files changed.
- The chosen Stackport fields.
- Required env variables and which `.env` path Stackport should write.
- Validation commands run and their results.
- Any remaining manual steps such as DNS, GitHub credentials, or SSL issuance.
