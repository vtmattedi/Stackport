# First VPS install postmortem

The first Ubuntu 26.04.1 install built and started Stackport, but setup and the
first project required manual interventions. HTTP process health was green while
public HTTPS was broken. These are the observed failures and their corrections.

| Observed failure | Cause | Correction |
| --- | --- | --- |
| Install completed before first login worked | Only port 3000 `/health` was checked; ingress starts asynchronously | Wait for HTTPS `/health` through nginx, validating domain certificate trust |
| ACME verification returned 404 | Generated nginx webroot differed from its mount destination | Align nginx mount with generated webroot |
| Initial issuance included www.sp | Alias logic did not match app routing | Request only Stackport's configured hostname |
| HTTPS disappeared on config regeneration | App user could not traverse Certbot's root-only directories; root-run generation could | Check existence through nginx container, and read public metadata through Docker; leave private key permissions intact |
| Failed bootstrap remained on HTTP | Startup skipped all configured domains, including failed setup | Track pending bootstrap and retry on restart; clear only after successful HTTPS apply |
| Nginx/Certbot appeared absent; SSL controls disabled | Status detection checked host binaries | Respect container mode, retaining separate host/container caches (previous follow-up fix) |
| Upstream host not found | Domain added after deploy; existing app container lacked proxy network | Connect existing routed containers and augment Compose for future recreations; resolve upstream DNS at request time so inactive workloads cannot block admin ingress |
| Generated file replacement denied | Root-run manual sed replaced app-owned file | Normal generation remains app-owned; installer/repair reconcile ownership; no manual edits needed |
| Duplicate www server warning | Explicit www route overlapped automatic redirect | Generate automatic redirect only when www is not explicitly routed |
| SSL demanded internal port | Legacy host-port guard remained | Validate domain service/container port instead (previous follow-up fix) |
| Update needed separate nginx recreation | CLI updated only app service | Reconcile system Compose stack on update/rollback; refresh installed CLI after success |

Also corrected: startup waits for nginx; missing curl/git/openssl are installed;
app port binds to loopback; redirects do not intercept ACME verification; rerunning
install restarts bootstrap without changing secrets. Repair regenerates derived
environment and uses Compose service `nginx`, rather than container name.

## Replacement VPS

Publish these changes before installing. Point the hostname/wildcard DNS at the
new VPS, check any IPv6 records, and permit SSH plus TCP 80/443 in the provider
firewall. Download the published script and run as root:

```bash
bash ./stackport.sh install --domain=sp.mattediworks.com --email=YOUR_EMAIL
```

Save the bootstrap credentials printed by the installer. After completion, open
the HTTPS hostname and create the admin. Deploy a Compose app with `expose`,
register its service/container-port route, and issue its certificate in Stackport.
No host `ports`, manual network connections, certificate chmod or nginx edits
should be necessary.

Build and issuance take time. Completion now checks local HTTPS with a trusted
domain certificate, but does not prove client reachability through provider
firewalls or refreshed DNS caches. If issuance fails, correct DNS/firewall and
rerun install; secrets and admin are preserved.

## Regression check

Run `powershell -File scripts/test-clean-install.ps1` with Docker's Linux engine.
It builds the production image and creates a disposable Docker-in-Docker daemon
without mounting the host Docker socket. It runs the real installer against a
fixture repository, substitutes a local test CA for Certbot, and checks failed
HTTPS, retry without secret changes, root-only certificate directory detection,
container status as node, ingress added after deployment, duplicate www handling,
project HTTPS, challenges after HTTPS, app restart, a stopped workload, and system
update/rollback reconciliation. Custom networks and aliases are preserved. The runner removes itself
and its temporary image archive afterward.

This exercises real nginx, Docker networking, database and HTTPS, but does not
test public ACME, production DNS, or Ubuntu's Docker installation/UFW steps.
Those require verification on the replacement VPS. The deprecated nginx http2
syntax is a non-blocking warning, unrelated to the observed failures.

Verification on 2026-09-15: backend `npm run typecheck`, production Docker build
(backend and frontend), and the complete isolated regression runner passed.
Transient connection errors immediately after nginx restart/reload were retried
until HTTPS served successfully. The runner and its temporary files were removed.
