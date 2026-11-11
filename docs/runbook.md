# Operator runbook

What to look at, in order, when something is wrong on a Stackport host. Written after the
[1.3.0 routing outage](1.3.5/postmortem-1.3.0-ingress-networks.md), where diagnosis lost time to a log command
that looked in the wrong place.

Run the host commands as root (`sudo`). Container names are fixed: `stackport` (the app) and
`stackport-nginx`.

## Where the logs are

| What | Where | Notes |
|---|---|---|
| Warnings and errors | `docker logs stackport` | Since 1.3.7 the app repeats warnings and errors on the console, so this is the first place to look. Lines are JSON; the `msg` field says what happened. |
| Everything the app logs | `/var/lib/stackport/logs/app.log` on the host (`/app/logs/app.log` in the container) | Info level and above (`LOG_LEVEL`). A line that is only here is routine. |
| Who did what | `/var/lib/stackport/logs/audit.log` | Also shown in the app under Logs. |
| nginx | `docker logs stackport-nginx` and `/var/lib/stackport/nginx/` | `failed.conf` is the last generated config nginx refused. |
| One deploy | The project's Deploys tab | Build and `compose` output for that action. |

```bash
docker logs --tail 200 stackport
docker logs --since 1h stackport 2>&1 | grep -E '"level":(40|50)'    # warnings (40) and errors (50)
```

## A project's site is down or returns 502

Three commands, in this order. Each one narrows it down.

**1. Is Stackport itself healthy, and is there room for more networks?**

```bash
sudo stackport status
```

Look at `health`, the `containers` list and the `networks:` line. If it says Docker has room for only a few
more networks, that is the cause of anything that fails to *create* a network (a deploy, a start-up). Enlarge
Docker's address pool as the warning explains.

**2. Can nginx see the service?** Ask from inside nginx, which is exactly what failed in 1.3.0. The name is
`sp<projectId>-<service>`, for example `sp7-web`; the port is the container port set on the domain.

```bash
docker exec stackport-nginx nslookup sp7-web 127.0.0.11
docker exec stackport-nginx sh -c 'nc -w 3 sp7-web 80 </dev/null; echo exit=$?'
```

- `nslookup` fails: the service is not on the `stackport-proxy` network under that name. Go to step 3.
- `nslookup` works and `exit=1` comes back at once: nothing is listening on that port. Check the service's own
  logs and the container port on the domain.
- `exit=1` after about 3 seconds: something answers the name but drops the connection.
- `exit=0`: nginx can reach it, so look at the application and at `nginx -t`.

The same check is in the app: the project's **Domains** tab shows *Routing*, and an MCP token can call
`stackport_get_project_ingress_health`.

**3. Who is on the shared network?**

```bash
docker network inspect stackport-proxy --format '{{range .Containers}}{{.Name}}  {{end}}'
docker inspect <container> --format '{{json .NetworkSettings.Networks}}'
```

`stackport-nginx` and every routed service must be in the first list, and the container's own entry must
list the alias `sp<id>-<service>`. A missing container means it was started before it was attached:
redeploy the project, or restart Stackport, which reconciles every project on start-up (`docker logs stackport`
then names each project it could not attach, with the reason).

## Do not hide errors

Do not add `2>/dev/null` or `|| true` while diagnosing. During the 1.3.0 outage part of the diagnosis time
went on a workaround whose errors were hidden by `2>/dev/null` (see the postmortem). Read the whole message:
the reason a command fails is usually in the output you would be throwing away.

## Other checks

```bash
docker exec stackport-nginx nginx -t      # is the generated config valid?
docker network ls | wc -l                 # how many networks exist (the pool holds about 31 by default)
sudo stackport repair                     # reconcile network, nginx scaffold, secrets ownership
sudo stackport rollback                   # back to the previous version, config included
```

`sudo stackport update` prints the network headroom before it starts. A warning there is a reason to enlarge
the pool first.
