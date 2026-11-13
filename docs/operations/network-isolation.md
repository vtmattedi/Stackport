# Per-project network isolation (P7)

Opt-in, per project, reversible. Project > Settings > **Network isolation**.

## Why

Since 1.3.1 every routed service of every project is on one network, `stackport-proxy`, with nginx. One
project's services can therefore reach another's, by alias or by service name. 1.3.0 tried to fix that with a
network per project and it took routed projects down: each network took a slice of Docker's default address
pool, which holds about 31 networks for the whole host
([postmortem](../incidents/1.3.0-network-outage.md)).

## What is different this time

| 1.3.0 | P7 |
|---|---|
| A network per project for everyone, switched on by an update | Off for every project. An admin switches one, and can switch it back |
| Subnet chosen by Docker from its default pool | Subnet chosen by Stackport from its own range, one /27 per project (`STACKPORT_ISOLATION_RANGE`, default `10.212.0.0/14`, room for 8192 projects). Docker's pool is not used |
| nginx's config switched, then the result seen | The new route is checked from inside nginx first. The old route stays in place and in nginx's config until then |
| No undo | Every step has one, and nothing is left half-done |

## What the switch does

Everything before step 5 can be undone by removing what was added, and the old route is untouched until then.

1. Create `stackport-iso-<id>` with an explicit `--subnet` from the range.
2. Connect nginx to it.
3. Connect each running routed container to it under `iso<id>-<service>`. (The alias differs from the shared
   `sp<id>-<service>`, so a lookup of it can only be answered on the new network.)
4. From inside nginx, check that every route resolves and accepts a connection on the new network
   (the same probe as Domains > Routing). If any does not, remove the network and stop: *nothing was changed*.
5. Set the flag and write nginx's config, so upstreams use `iso<id>-<service>`. If nginx refuses it, restore the
   flag and the config and remove the network.
6. Check the routes again through the new config.
7. Rewrite the project's Compose attachments (so the next deploy keeps them), move TCP proxies onto the network.
8. Take the services off `stackport-proxy`. This is last, and only after the route works. If it fails the
   isolation stays in place and the next start-up retries.

Switching back is the mirror: put the services on the shared network, check `sp<id>-<service>` from nginx, then
switch nginx's config, then remove `stackport-iso-<id>`.

## Keeping it in place

- **Deploys:** the Compose rewrite attaches routed services to `stackport-iso-<id>` instead of the shared network, and the
  compose policy accepts exactly that network and alias for exactly that project, and no other project's.
- **Start-up:** each isolated project's network is made if missing, nginx is connected to it, the services are
  connected and taken off the shared network. A recreated nginx loses networks it was connected to by hand, so
  this is what brings the routes back after an update. If it fails, Domains > Routing and
  `stackport_get_project_ingress_health` say why (name does not resolve, nginx not on the network).
- **Deleting a project** removes its network when nothing is still on it.

## Decisions

- **Opt-in, not default.** The pool incident came from changing everyone at once. Nothing changes for a project
  until an admin switches it.
- **One /27 per project.** 30 addresses for nginx and the routed services; the range is configurable because it must not overlap anything else on the host.
  Docker refuses an overlapping subnet; the error is shown with the variable to change.
- **Not listed as a missing protection** in Settings > Project protections: it is off everywhere by default, so
  listing it would flag every project.

## Before `stackport rollback`

An older release does not know the isolated network. Its policy refuses a Compose file that joins it, so the next
deploy of an isolated project would be rejected. **Switch isolated projects back to the shared network before
rolling back.** Routing itself should keep working after a rollback, because the older release attaches routed services to the
shared network at start-up and writes nginx's config with the shared aliases. That is read from the code, not
tested; do the switch-back first.

## Verification

Unit tests (`tests/isolation.test.ts`) cover the subnet allocation, the Compose rewrite both ways, the policy, nginx's
config following the flag and every branch of the switch with a fake Docker. The clean-install scenario
(`scripts/tests/clean-install.sh`) runs it against a real Docker daemon with the address pool used up: the subnet,
the network membership, the route through nginx, nginx recreated and Stackport restarted, and the switch back.
