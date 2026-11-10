# Stackport 1.4 (plan)

Not started. This page collects what is decided for 1.4 so far; the reasoning is in the postmortem.

## Update safety: regression report, restore point, Restore (P1)

From [../1.3.5/postmortem-1.3.0-ingress-networks.md](../1.3.5/postmortem-1.3.0-ingress-networks.md), section "P1 in detail". In short:

- `stackport update` probes every route before the swap and after it, and reports only what the update broke. A route that was already down is listed separately and not blamed. The probe asks nginx's own network whether each upstream resolves and accepts a connection.
- The update never undoes itself. There is no automatic alert for now. A version that cannot start or does not report ready is still rolled back as today.
- A **restore point** records what an update changes outside the image: container networks and aliases, existing networks, TCP proxies, the nginx config and rewritten Compose files, next to the database copy the update already takes.
- **Restore** (System page and `sudo stackport restore`) shows what it would do, then rolls the image back and replays the recorded state on request. Restoring the database is a separate, off-by-default choice with what it discards spelled out.
- The baseline probe runs from the staged new image, between the database backup and the swap, reading its route list from the backup copy.
- Keep the last two restore points, once the size is measured. Update backups under `/var/lib/stackport/backups/` are not pruned today.

## Database backup and restore

Stackport's database gets a first-class backup and restore, not only as part of an update: **Back up now** and **Restore a backup** on the System page, `stackport backup` and `stackport restore --database`, with their own retention. Scheduled off-host copies (A2) belong with this.

| ID | Item | Size |
|---|---|---|
| P1 | Regression report, restore point, Restore | L |
| DB | Database backup and restore (manual, with retention) | M |
| A2 | Scheduled off-host backups | M |

## Why 1.4 and not 1.3.5

It is a feature set of its own (a probe, a state record, a replay with a preview, buttons, pruning, two new commands) and it needs testing against a real Docker host with many projects. 1.3.5 keeps the items that prevent a repeat of the incident: network headroom warnings (P3), warnings in `docker logs` (P4), a pool-exhaustion scenario in the clean-install test (P5), the staging gate (P6), per-project isolation done safely (P7) and the runbook (P8), plus the GitHub App.
