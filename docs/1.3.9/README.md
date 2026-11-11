# Stackport 1.3.9

Started 11 November 2026, from 1.3.8.

## Decided

- **The version a server shows is the version that shipped.** `package.json` (and the six other files that record it) is raised in
  the branch, and a new check on pull requests to `main` ([version-gate.yml](../../.github/workflows/version-gate.yml),
  [version-gate.sh](../../scripts/ci/version-gate.sh)) refuses a version that is not higher than main's, or one that differs from a branch
  named like a version. 1.3.7 ran as `v1.3.1` because nothing checked this.
- **The temporary Migrations page is gone.** Removed: the managed-volume copy (S2), the removal of the original mounts, and the env-value
  encryption (S13). Kept, and renamed Settings > Encryption: re-encrypting the stored secrets, because it is how an encryption key (or
  `JWT_SECRET`) is rotated. **Consequence:** a project that was created before 1.3 and still has managed volumes off can no longer be
  switched over from the UI. It keeps its current mounts. Check Settings > Project protections before updating a server that still has such
  a project, and migrate it on 1.3.8 first.

- **Settings is grouped, and Host has two new pages.** Settings: Instance (General, Notifications), Deploy (Deploy triggers, Domains,
  Protections), Integrations (GitHub, Credentials, MCP), Security (Encryption). Container defaults and Project protections are one page,
  Protections; Storage and Maintenance moved to Host > Docker. Old URLs redirect. Host: Hardware, Docker, **Networks**, Nginx, Certbot, **Power**.
- **Host > Networks.** Every Docker network with its owner (Docker, Stackport, a project, a network group, an isolated project, left by 1.3.0, or
  something else), its subnets, the slices of Docker's address pool it takes, and what is attached; the pool headroom; networks with nothing
  attached can be removed (never Docker's or Stackport's own; checked again right before removal). An MCP read tool lists the same.
- **Enlarging the address pool is a host command**, `sudo stackport network-pool set --base 10.20.0.0/14 --size 24`: it checks the range against
  the host's routes, backs up `daemon.json`, asks before restarting Docker, and puts the old file back if Docker does not come up.
- **Host > Power and `sudo stackport reboot`.** The app cannot reboot the machine and is not given a way to. It writes a signed request file
  (HMAC with `STACKPORT_POWER_KEY`, which lives in root-only `secrets.env`); a systemd path unit that install and repair set up runs
  `stackport power-run`, which refuses anything unsigned, stale, malformed or oversized, consumes it first, and schedules `shutdown -r`. The page lists
  the running actions and the running containers with no restart policy (they stay stopped after a reboot) and needs the typed word. Not exposed over
  MCP. **After updating to 1.3.9 run `sudo stackport repair` once**: it adds the key and the units (the running 1.3.8 script cannot).
- **The GitHub App manifest no longer names the `installation` events**, which GitHub refuses ("Default events unsupported").

## Not verified

- **The systemd units on a real host.** The shell logic is tested in real bash (signing, refusals, the pool command with stubs for Docker, `ip` and
  `systemctl`), and the Docker-in-Docker install regression covers the no-systemd path. A real `systemctl enable --now stackport-power.path`,
  a real reboot and a real Docker restart have not been run.
- The GitHub App registration, still, against github.com.

## Planned, not built

See [ui-pass.md](ui-pass.md). Not built: Hostinger's API (a later "Providers" feature; the app once had a Hostinger firewall tab, since removed) and starting
the projects that were running before a reboot.
