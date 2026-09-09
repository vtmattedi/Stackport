# Project Specs — Deploying on Stackport

This document describes Stackport (the platform implemented in this repo, `stackport-mw-vps-manager`) from the perspective of a **project** being deployed on it: how a project's lifecycle works, what you need to prepare in your repo before onboarding, and the division of responsibility between you (the project owner) and Stackport.

Stackport is a self-hosted VPS management and deployment platform. It clones your GitHub repo, runs your `docker-compose.yml`, fronts it with Nginx + Let's Encrypt SSL, polls for new commits, and health-checks the running container — all from a single admin UI/API.

## 1. Project Lifecycle

A project in Stackport moves through these stages:

1. **Registration** — `POST /api/projects` creates the project record (name, GitHub repo, port, domain, etc.). No code has been pulled yet.
2. **Pull** — `POST /api/projects/:id/pull` clones the repo (first time) or runs `git fetch --all --prune && git pull --ff-only` into `{deployRoot}/{projectId}-{slug}/`. Private repos use the configured `githubCredentialId`.
3. **Build** — `POST /api/projects/:id/build` runs `docker compose build` in the project directory (15 min timeout).
4. **Deploy** — `POST /api/projects/:id/deploy` writes any configured `.env` files, then runs `docker compose up -d --build`. This is the combined pull+build+up path most projects use day to day.
5. **Routing** — if `domain` + `internalPort` are set, Stackport regenerates its Nginx config so `https://{domain}` proxies to `localhost:{internalPort}`.
6. **SSL issuance** — `POST /api/projects/:id/ssl/issue` runs Certbot for the apex domain and `www.` subdomain (one-time per domain change, auto-renews after).
7. **Steady state** — Stackport polls GitHub for the `auto_deploy_branch` on an interval; a new commit SHA triggers an automatic pull/build/deploy. In parallel, if a health check endpoint is configured, Stackport polls it every `healthCheckIntervalS` (minimum 30s) and records up/down status, response time, and last-checked time.
8. **Quick restart** — `POST /api/projects/:id/compose` re-runs `docker compose up -d --build` without re-pulling — useful after only changing env vars.
9. **Stop** — `POST /api/projects/:id/stop` runs `docker compose down`.
10. **Pause** — setting `paused` skips both auto-deploy polling and health checks without removing the project.
11. **Deletion** — removes the DB record; the on-disk repo folder becomes orphaned and is surfaced via the repo-folder-scan/cleanup endpoints for manual or scripted removal.

Every pull/build/deploy run is recorded in deploy history with status and streamed live over WebSocket so you can watch logs in real time.

## 2. Preparing Your Project for Stackport

Your GitHub repo must provide:

- **`docker-compose.yml`** (or `compose.yml`) at the repo root. This is the only deployment artifact Stackport understands — there are no required `npm`/build scripts outside of what your Dockerfile(s) already do.
- At least one service that **exposes a port** and **listens on `localhost`/`0.0.0.0` inside the container** at the port you plan to register as `internalPort`. Stackport's Nginx proxies from the host to `localhost:{internalPort}`, so your container's published port mapping must match.
- Optionally, a **health check endpoint** (e.g. `GET /health`) that returns a 2xx status when the service is healthy. It will be called as `https://{domain}{healthCheckEndpoint}` with a 10s timeout — make sure it responds well within that.
- Your app should **not** terminate TLS itself — Stackport/Nginx handles HTTPS termination and Certbot certificate renewal. Your container only needs to speak plain HTTP on its internal port.
- Avoid binding to ports below 1024 (these require root inside the container) and pick a port that won't collide with other projects on the same VPS — Stackport rejects duplicate `internalPort`/`domain` values across projects, and reserves its own Nginx port.
- If your app needs secrets or configuration, read them from a `.env` file at a path you tell Stackport about (e.g. `.env`, `config/.env.production`). Don't commit real secrets to the repo — they're managed in Stackport and written to disk just before each deploy.
  - `.env` file paths must end in `.env`, stay within the repo (no `..`, no absolute paths), and be ≤240 characters.
  - Variable keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; values can't contain newlines.

Before registering the project, decide on:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name, ≤100 chars |
| `githubRepo` | yes | `owner/repo` format |
| `internalPort` | no | 1–65535, must be unique across projects, can't equal Stackport's own Nginx port |
| `domain` | no | Valid FQDN, must be unique across projects; needed for routing/SSL/health checks |
| `healthCheckEndpoint` | no | Must start with `/`; only checked if `domain` is also set |
| `healthCheckIntervalS` | no | Effective minimum 30s |
| `githubCredentialId` | no | Required only for private repos |
| `auto_deploy_branch` | no | Branch Stackport polls for new commits to trigger auto-deploy |

## 3. Division of Responsibility

**What Stackport does for you:**
- Clones/updates your repo from GitHub (with stored credentials for private repos).
- Writes configured `.env` files to the repo before each deploy.
- Runs `docker compose build` / `up -d --build` / `down` and streams logs live.
- Generates and reloads Nginx routing config for all projects with a `domain` + `internalPort`.
- Issues and renews Let's Encrypt SSL certificates via Certbot.
- Polls GitHub for new commits on the watched branch and auto-redeploys.
- Periodically calls your health check endpoint and records status/latency.
- Sends notifications (e.g. email) on health check transitions to "down".
- Retains deploy history and exposes metrics (deploy outcomes over time, Nginx access log stats, per-domain traffic breakdown).
- Isolates each project's working directory and containers from other projects on the same VPS.

**What's expected from you (the project owner):**
- Provide a working `docker-compose.yml` that builds and runs your app, exposing the agreed-upon port.
- Keep the app stateless about TLS — plain HTTP on the internal port.
- Implement and maintain a lightweight, fast (`<10s`) health check endpoint if you want monitoring/alerting.
- Read configuration from environment variables / `.env` files rather than hardcoding secrets in the repo.
- Choose and register a unique internal port and domain, and update them in Stackport (not just in your compose file) if they change.
- Keep the watched branch (`auto_deploy_branch`) stable — every new commit there will be auto-deployed to production-equivalent infrastructure.
- Clean up orphaned repo folders / pause or delete the project in Stackport when it's no longer needed, rather than leaving stale containers running.

## 4. Notes

- Stackport has no concept of staging vs. production environments per se — each registered project is one deployable unit pointing at one branch and one domain. To run multiple environments for the same codebase, register multiple Stackport projects (e.g. different domains/ports) pointing at different branches.
- A generic, separate webhook endpoint (`POST /api/webhooks/trigger/:slug`, HMAC-signed with `WEBHOOK_SECRET`) exists for running arbitrary pre-approved scripts on the VPS — this is unrelated to auto-deploy and not required for normal project onboarding.
