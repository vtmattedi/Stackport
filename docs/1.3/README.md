# Stackport 1.3: what 1.2 left open

Stackport 1.2.0 shipped everything agreed in [`docs/plan.md`](../plan.md) (PRs 1–25).
This folder lists what it did **not** do: the security work that was deliberately
held back, features that were proposed and deferred, and smaller issues found along
the way. Nothing here is scheduled yet; each item needs a decision before work starts.

| File | Contents |
|---|---|
| [security.md](security.md) | The S items: Compose isolation, secrets, network, sessions |
| [backlog.md](backlog.md) | Features and smaller fixes that aren't security |
| [verification.md](verification.md) | Shipped in 1.2 but only tested outside a real host |

`docs/deprecated/` is dropped: nothing in it is a plan or a requirement any more.

## Ratings

Same scale as the 1.2 plan.

| Criticality | Meaning |
|---|---|
| 🔴 Critical | Host compromise from repository content |
| 🟠 High | Security hole, data loss or outage risk |
| 🟡 Medium | Correctness or maintainability |
| ⚪ Low | Polish |

| Effort | Meaning (one developer familiar with the code) |
|---|---|
| S | About a day or less |
| M | 2–4 days |
| L | 1–2 weeks |
| XL | More than 2 weeks |

## Everything at a glance

Ordered by criticality, then by how much each item unblocks.

| # | Item | Crit | Effort | Needs | File |
|---|---|---|---|---|---|
| S14 | Run `docker compose` with a minimal environment | 🔴 | S | — | security |
| S1 | Compose policy: allowlist the resolved config | 🔴 | L | — | security |
| S2 | Volume model: Stackport-owned mount directories | 🔴 | L | S1 | security |
| S3 | Take Stackport off the `stackport-proxy` network | 🟠 | M | — | security |
| S4 | Narrow `trust proxy` | 🟠 | S | — | security |
| S8 | Hardened container defaults | 🟠 | M | S1 | security |
| S11 | Docker socket containment | 🟠 | XL | — | security |
| S5 | Write access over MCP | 🟠 | L | S6 | security |
| A2 | Scheduled off-host backups | 🟠 | M | — | backlog |
| S6 | Session lifetime cap, httpOnly cookie | 🟡 | M | — | security |
| S7 | Separate encryption key, with versioning | 🟡 | M | — | security |
| S13 | Encrypt managed env values at rest | 🟡 | M | S7 | security |
| S9 | Per-project ingress networks | 🟡 | M | S3 | security |
| S10 | Block cloud metadata and LAN egress | 🟡 | M | — | security |
| S12 | `resolveContainedPath` should resolve symlinks | 🟡 | S | — | security |
| MCP-2 | OAuth for claude.ai connectors | 🟡 | L | — | backlog |
| A1 | Deploy prebuilt images by digest | 🟡 | M | S1 | backlog |
| U4b | Show volume mappings on the project page | 🟡 | S | S2 | backlog |
| B1 | Pin the rollback target from the preview | ⚪ | S | — | backlog |
| B2 | Upstream keepalive in the nginx proxy blocks | ⚪ | S | — | backlog |
| B3 | Bound the GitHub ETag cache | ⚪ | S | — | backlog |
| B4 | Palette: deploy a chosen branch | ⚪ | S | — | backlog |
| B5 | Lint warnings (110) | ⚪ | M | — | backlog |
| B6 | `Stackport.md` for 1.2's behaviour changes | ⚪ | S | — | backlog |
| B7 | Delete `docs/deprecated/` | ⚪ | S | — | backlog |
| B8 | Delete merged remote branches | ⚪ | S | — | backlog |
| N1 | `/version.json` exposes the exact commit without auth | ⚪ | S | — | backlog |
| A3 | Build before `up`, blue-green | ⚪ | L | — | backlog |

**Until S14, S1 and S2 land:** treat every repository Stackport deploys as able to run
code as root on the host. Turn off auto-deploy for any repository that someone other
than the admin can push to.
