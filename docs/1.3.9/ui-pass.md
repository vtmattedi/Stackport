# 1.3.9: the Settings and Host pages, host reboot and Docker networks

Written 11 November 2026 from screenshots of the real UI (`npm run ui:shots`, 1440 px, 15 pages) and the code. Nothing here is built yet.

## What the pages are today

**Settings, 13 flat entries:** General, Deploy triggers, Notifications, Domains, GitHub, Credentials, MCP, Storage, Container defaults,
Project protections, Maintenance, Encryption. No grouping, so the list reads as a pile.

**Host, 4 entries:** Nginx, Docker, Certbot, Hardware. The only trace of Docker networks is a headroom notice.

What the screenshots show:

- **Things that belong together are apart.** Container defaults and Project protections are both "protections". Credentials, GitHub and
  MCP are all "how something proves who it is". Domains (Settings) and Certbot (Host) are one subject.
- **Things that belong on Host are in Settings.** Storage (Docker disk usage, prune) and Maintenance (a repo folder scan) are about the
  machine, not about configuring Stackport.
- **Thin pages.** Project protections is one paragraph and "Every project has all three protections on". Maintenance is one button.
- **Nothing scrolls sideways** on any of the 15 pages at 1440 px. Narrow widths were only checked for MCP.
- Host > Docker still showed a skeleton after 1.2 s: the page waits for the whole system snapshot.

## Options for the navigation

| | What it is | Cost | Risk |
|---|---|---|---|
| **A. Group the sidebar** | Same pages, with headings: Instance (General, Notifications), Deploy (Deploy triggers, Domains, Container defaults, Project protections), Integrations (GitHub, Credentials, MCP), Security (Encryption). No page changes | Small | None: URLs stay |
| **B. Merge and move** (A, plus) | Container defaults + Project protections become **Protections** (defaults on top, per-project status below). Storage and Maintenance move to Host. Credentials, GitHub and MCP stay separate pages under one heading | Medium | Old URLs need redirects |
| **C. Two-level pages with tabs** | Settings becomes 5 pages (Instance, Deploy, Integrations, Security, Notifications), each with tabs | Large | Biggest rewrite, deep links break |

**Recommendation: B.** It fixes the real problems (a pile, two protections pages, host things in Settings) without a rewrite. C looks
tidy but costs a lot for a list that is only 13 long.

Resulting layout under B:

- **Settings:** General, Notifications · *Deploy:* Deploy triggers, Domains, Protections · *Integrations:* GitHub, Credentials, MCP · *Security:* Encryption
- **Host:** Hardware, Docker (containers and storage), **Networks** (new), Nginx, Certbot, **Power** (new)

## Host reboot

Stackport runs in a container with the Docker socket and a few read-only host mounts. It has no privileged mode and no host PID.

| Option | How | For | Against |
|---|---|---|---|
| **1. Local, privileged helper container** | `docker run --privileged --pid=host` a throwaway container that runs `reboot` in the host's namespaces | No vendor, no new secret, works on any VPS | A privileged container. The Docker socket is already root-equivalent, but this is the first time Stackport would use it on purpose |
| **2. Host-side command** | `stackport reboot` and a systemd path unit that acts on a request file the app writes | Least privilege, auditable, no privileged container | Installer change; existing hosts need `stackport update` or `repair` to get it |
| **3. Hostinger's API** | `POST /api/vps/v1/virtual-machines/{id}/restart` with an API token (from third-party mirrors of Hostinger's docs; check Hostinger's own page before relying on it) | Works from outside the machine; same API has stop, start, snapshots and backups | A stored token, the VM id, Hostinger only. It stops and starts the VM rather than asking the OS to reboot. Does nothing when Stackport itself is down, which is when it is most wanted |

**Do you need Hostinger's API?** Not for a reboot. It earns a place only for things the host cannot do for itself: recovery when the
machine or Docker is wedged, a snapshot before a risky change (like enlarging the Docker address pool), or metrics from outside. That is
a later "Providers" integration, not part of this.

**Recommendation:** option 2, with option 1 as the fallback if changing the installer is too much for 1.3.9. Put it in **Host > Power**,
with a typed confirmation, a list of running deploys and actions it would interrupt, an audit entry, and after the reboot a check that
every project came back (the health checks already exist). **Not exposed over MCP.** A read-and-write token should not be able to take the
machine down.

## Docker network management

What exists: network groups per project (S15), the isolation switch per project (P7), a headroom notice, `stackport status`. What does not:
a place to see networks, who owns them, or clean them up.

**Host > Networks**, in three steps:

- **N1, read only.** Every network with its driver, subnet, how many containers, and who owns it (a project, a network group, Stackport's own, or
  something else on the host). The headroom bar and the daemon's address pools. An MCP read tool for the same list.
- **N2, prune.** Networks with no containers, with a preview. Never `stackport-proxy`, `stackport_default` or a network group.
- **N3, enlarge the pool.** A host command (`stackport network-pool`) that merges into `daemon.json`, checks the range against the host's
  routes, backs up the file and asks before restarting Docker. The page shows the command and the current state but does not restart Docker
  itself. It needs a Docker restart, so it pairs with the Power page's pre-flight list.

## Suggested scope for 1.3.9

Done: version and its gate, the Migrations page removed. Next, in this order: B (navigation), N1, Power (option 2), N2, N3. Each is its own
commit; the PR opens at the end.
