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
