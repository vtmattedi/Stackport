# Operator runbook

What to look at, in order, when something is wrong on a Stackport host. Written after the
[1.3.0 routing outage](../incidents/1.3.0-network-outage.md), where diagnosis lost time to a log command
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

**2. Can Nginx see the service?** Ask from inside Nginx, which is exactly what failed in 1.3.0. For a normal routed project the upstream alias is `sp<projectId>-<service>`, for example `sp7-web`. For a project with **Network isolation** enabled the upstream alias is instead `iso<projectId>-<service>` (for example `iso7-web`). Use the alias actually shown in the generated Nginx configuration or the project's Domains → Routing view, and its configured container port.

```bash
docker exec stackport-nginx nslookup sp7-web 127.0.0.11
docker exec stackport-nginx sh -c 'nc -w 3 sp7-web 80 </dev/null; echo exit=$?'
```

- `nslookup` fails: Nginx cannot resolve the selected alias from any network it shares with the service. Go to step 3.
- `nslookup` works and `exit=1` comes back at once: nothing is listening on that port. Check the service's own
  logs and the container port on the domain.
- `exit=1` after about 3 seconds: something answers the name but drops the connection.
- `exit=0`: nginx can reach it, so look at the application and at `nginx -t`.

The same check is in the app: the project's **Domains** tab shows *Routing*, and an MCP token can call
`stackport_get_project_ingress_health`.

**3. Which ingress network should contain the service?**

```bash
docker network inspect stackport-proxy --format '{{range .Containers}}{{.Name}}  {{end}}'
docker inspect <container> --format '{{json .NetworkSettings.Networks}}'
```

For **non-isolated** projects, Nginx and each routed service must share `stackport-proxy`, and the service container needs the `sp<id>-<service>` alias. For an **isolated** project, inspect `stackport-iso-<id>` instead; Nginx and the service must share it under `iso<id>-<service>`:

```bash
docker network inspect stackport-iso-7 --format '{{range .Containers}}{{.Name}}  {{end}}'
docker inspect <container> --format '{{json .NetworkSettings.Networks}}'
```

Missing attachments may be repaired by the next Stackport startup or a redeploy; check `docker logs stackport` for reconciliation errors. Do not manually detach working routes or change Nginx first. See [Network isolation](network-isolation.md).

## Do not hide errors

Do not add `2>/dev/null` or `|| true` while diagnosing. During the 1.3.0 outage part of the diagnosis time
went on a workaround whose errors were hidden by `2>/dev/null` (see the postmortem). Read the whole message:
the reason a command fails is usually in the output you would be throwing away.

## Other checks

```bash
docker exec stackport-nginx nginx -t      # is the generated config valid?
docker network ls | wc -l                 # network count; available address pools depend on Docker configuration
sudo stackport repair                     # reconcile network, nginx scaffold, secrets ownership
sudo stackport rollback                   # previous Stackport version; NOT a full ingress/network/data restore
```

`sudo stackport update` prints the network headroom before it starts. A warning there is a reason to enlarge
the pool first:

```bash
sudo stackport network-pool                                      # where things stand
sudo stackport network-pool set --base 10.20.0.0/14 --size 24    # room for 1024 networks
```

`set` checks the range against this host's routes and interfaces (it refuses one that clashes with a VPN or a private
network), backs up `/etc/docker/daemon.json`, lists the containers that will not restart by themselves, and asks before
restarting Docker, which stops every container until it starts again (unless `live-restore` is on). If Docker does not come back it puts the old
file back. Networks that exist keep their ranges. `--no-restart` writes the file and leaves the restart to you. Host > Networks in the UI shows
the same numbers and which networks use them, and can remove the ones nothing is attached to.

To reboot the machine: `sudo stackport reboot [--in <minutes>]`, or Host → Power. On older installations upgraded from before 1.3.9, `sudo stackport repair` reconciles the host power units. **A Stackport image rollback does not replay all Docker network, generated Nginx or workload state.** Operator-controlled update infrastructure restore points are a separate, [planned 1.5 feature](../roadmap/1.5.md).
