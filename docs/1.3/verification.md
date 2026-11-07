# Shipped in 1.2, not yet verified on a real host

These work in tests and in a local run, but the local environment lacked something
real (Docker, a GitHub token, production data). Check each on a deployed install after
updating to 1.2.0.

| Feature | What wasn't available | How to check |
|---|---|---|
| Host mounts (PR 24) | Docker; tested with the sandbox's own `/sys` and a stand-in data root | Host > Hardware shows disk and network; Host > Docker's storage state is no longer "unknown" |
| Disk guard and cleanup back on (PR 24) | Docker | With the storage state known, a deploy at "critical" prunes the build cache first |
| Deploy preview commit list (PR 18) | A GitHub token (anonymous API was rate-limited); tested with a mocked GitHub | Redeploy on a project with a token: the dialog lists new commits and the Compose diff |
| Ping spikes (PR 21) | Real Docker data and network; never reproduced locally (pings were 1–4 ms) | If the indicator still spikes past 1 s, note the page and whether the tab had been in the background |
| `STACKPORT_DOCKER_ROOT` (PR 24) | A host with a moved Docker data root | On such a host, `.env` has the variable after `stackport repair` and disk shows the right filesystem |

## Built in 1.3, not yet verified on a real host

| Feature | What wasn't available | How to check |
|---|---|---|
| Managed mounts and the volume migration (S2) | A running Docker daemon; only the planning, the override merge (real `docker compose config`) and the migration logic with a fake Docker were tested | On a copy of a real install: Settings > Migrations > Dry run, read where each project's data was found, Execute, redeploy, and confirm the project sees its data. Check `<data>/volumes/<project>/` ownership matches the container user |
| Where existing bind-mount data lives (S2) | A host with deployed projects | Dry run reports the path it found; confirm whether it is under `/app/data/repos/...` on the host or under the data directory |
| Stackport off `stackport-proxy` (S3) | A running stack | After `stackport update`: the admin UI still loads through nginx, `docker exec <project container> wget -qO- http://stackport:3000` fails, and `docker network inspect stackport-proxy` lists nginx but not `stackport` |
| Trusted proxy address (S4) | A running stack with nginx | Log in with a wrong password a few times from two different networks: each gets its own rate-limit bucket and the audit log shows the real client address, not nginx's. No `trusted-proxy.lookup-failed` warnings in the logs |
| Hardened container defaults (S8) | A running Docker daemon; the override was only merged with `docker compose config` | Turn it on for one project, deploy, and `docker inspect` a service: `SecurityOpt` has `no-new-privileges:true`, `HostConfig.Memory` and `PidsLimit` match Settings > Container defaults. Check a database service still starts under the 1 GB default |
| Session cookie and lifetime cap (S6) | A browser over real HTTPS behind nginx | Log in: the cookie has HttpOnly, Secure and SameSite=Strict, and `localStorage` holds no token. A POST from the browser console without `X-Requested-With` returns 403. Live updates (Socket.IO) connect. After the cap (or by lowering `SESSION_MAX_HOURS`) the next request returns to the login page |
| MCP write tools (S5) | A real MCP client and a deployable project | Create a read-and-write token (Settings > MCP), add it to Claude Code, call `stackport_deploy_project` with no `confirmationId` (nothing runs, you get an id), then again with it (the deploy starts and shows in the project's actions). Repeat with the same id: refused. A token limited to one group is refused on a project outside it. Audit log shows `mcp.write.preview`, `mcp.write` and `mcp.write.deploy.finished` |
| Separate encryption key (S7) | An existing install with stored credentials | After `sudo stackport update` or `repair`, `secrets.env` has `ENCRYPTION_KEY`. Existing credentials still work (deploy a private repo). Settings > Migrations > Re-encrypt: the dry run lists the old-key count, execute moves them, and a second dry run says all are current. Then a deploy and a notification test email still work |
| Encrypted env values (S13) | A project with env values saved before 1.3 | In the project's env editor the values still show (masked) and a deploy writes the right `.env`. Settings > Migrations > Encrypt managed env values: dry run lists the files, execute encrypts them; `sqlite3 stackport.sqlite "select variables_json from project_env_files"` then shows only `[]` |
| Copy verification and the running-project refusal (S2) | A running Docker daemon with real project data | With a project running, Settings > Migrations > Dry run lists it as blocked ("containers are running"); stop it, run again, execute: the report says the copy was verified. The verification (`diff -rq` in the helper image) has only been exercised with a fake Docker; check it on a directory with symlinks and an empty directory |
| Files Compose reads, networks and volumes (S1) | A real Stackport container | Deploy a new project whose Compose file has `env_file: /app/.env`, a service on an external network named `stackport_default`, or an external volume: each is rejected with the service and key. Then deploy an ordinary project (default network, a named volume, `stackport-proxy` attached) and confirm it is accepted |
