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

From 1.4.10, server startup checks Stackport's saved hostname when publishing and HTTPS are enabled. If its certificate is missing, startup applies the HTTP challenge route, requests the certificate using the saved Certbot settings, then reapplies nginx for HTTPS. DNS must reach this host and a Certbot email must be configured. A failure is logged and retried on the next startup. Existing certificates, explicit HTTP settings and disabled publishing are preserved; the installer's `STACKPORT_DOMAIN` does not replace a saved hostname.

When you add or rename a routed hostname, Stackport requests a certificate and redirects HTTP to HTTPS once it is ready. Set **Allow non-secure HTTP** to serve the hostname over plain HTTP instead. A new HTTPS route serves the HTTP-01 challenge and returns 503 for other HTTP requests until it has a certificate. Point every name on the route at this server, including both the bare domain and `www` if they share a route. If issuance fails, check DNS and the Certbot email, then use **Issue cert** on the domain. If a hostname rename fails before the new route is ready, Stackport keeps the old route so you can retry. Stackport also obtains a certificate before switching its own address.

Use **Branch deployments** on a GitHub project to add one deployment per branch. Each deployment builds and runs independently and gets a generated hostname under the default base domain. Point wildcard DNS for that base domain at Stackport, or create a DNS record for each generated hostname. Stackport uses the primary route if the branch exposes the same service and port, or the branch's sole available target. Choose the route in **Domains** when several targets remain.

Choose **Separate env files** to enter branch-specific values, or **Shared env files** to use the primary deployment's managed values on each deploy. Branch deployments start with manual deployment enabled. Their checkouts and Docker data use separate names, so Compose files must omit fixed container names and use deployment-specific tags for built images. A full backup carries the parent and its branch deployments together.

For GitHub App projects, choose **Post the preview URL on the pull request** to publish the HTTPS link to a matching open PR after deployment. Grant the App **Pull requests: Read and write** if the installation does not already have it. GitHub permission failures appear in the action log.

`npm run test:ingress:docker` exercises this startup path with real nginx, a saved hostname and a locally issued test certificate, then checks that a later startup reuses it. Readiness, challenge serving, certificate detection, config generation, validation and reload use production code; the external CA is substituted. It needs local `stackport:ci`, `nginx:1.29-alpine` and `certbot/certbot` images, uses disposable Docker resources and publishes no host ports.

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

## Backup and restore (levels 1 and 2)

`sudo stackport backup [--level 1|2] [--out FILE]` writes one passphrase-encrypted archive (scrypt + AES-256-GCM; the
passphrase is the only key and Stackport cannot recover it). It is separate from the automatic database copy `update` makes
(`/var/lib/stackport/backups/update-*`), which only protects an update.

| Level | Contains | Does **not** contain |
| --- | --- | --- |
| 1 | Instance settings, administrator identity (**password hash**, never the password), credentials, integrations, global domains, webhook scripts, and the keys that decrypt the stored secrets | Projects of any kind |
| 2 (default) | Level 1 plus every project's record, source and deployment configuration, Compose snapshots, managed `.env` files **with their secret values**, domains/routes, health checks and files uploaded for manually uploaded projects | Workload data |

Neither level contains application data: databases, volumes, uploaded user files and broker state are **not** recovered by
a restore, and Git checkouts, certificates, generated nginx config, sessions and history are not included either (the
archive's manifest lists every exclusion; `stackport backup-verify FILE` prints it). Level 3 (workload data) is not
available yet. Keep archives off the host and treat them as secrets: they hold the key material for every stored credential.

```bash
sudo stackport backup --level 2 --out ~/stackport-l2.spbackup
sudo stackport backup-verify ~/stackport-l2.spbackup            # authenticates, checks checksums, schema and that every secret decrypts
sudo stackport restore ~/stackport-l2.spbackup --mode recover   # or --mode clone
```

`restore` **replaces** the installation's configuration (it does not merge). It verifies the archive first, asks you to
type `RESTORE`, stops Stackport (applications keep running), restores in a one-off container, adopts the archive's keys into
`/etc/stackport/secrets.env`, and starts Stackport again. It works with the web UI down. The previous database,
replaced directories and `secrets.env` are kept under `/var/lib/stackport/data/backups/pre-restore-*` and
`/var/lib/stackport/backups/pre-restore-*`; if the restore fails, nothing is changed and Stackport is started again.

- **recover** keeps the instance id, name, administrator password hash and credentials: use it to replace a lost or moved host. Sessions are ended.
- **clone** gives the copy a **new instance id** (the display name may match), ends sessions, removes API tokens and the GitHub App registration, turns GitHub polling, email, web push and webhook scripts off, and pauses every project with its GitHub hooks and automatic-deploy settings cleared. Re-enable each deliberately; two live copies must not process the same webhooks, MQTT writes or OAuth callbacks.
- Host-specific values (domain, certificates) are shown, never applied. On a different machine check `nginx_app_domain` and re-issue certificates.
- An archive made by a newer Stackport is refused (update first); an older one is migrated on restore.
