# Staging gate

Some changes cannot be proved by unit tests or by the clean-install run, because what they depend on is a real
Docker daemon, a real nginx or a real host: how many networks exist, which address a container gets, what
happens when a service starts before its network. 1.3.0 shipped a change like that with its verification row
still unticked, and it took routed projects down ([postmortem](1.3.5/postmortem-1.3.0-ingress-networks.md)).
This gate makes the check part of the pull request.

## What counts

A pull request that changes any of these needs a result from a real host:

- Docker networks, aliases or attachment: `src/modules/ingress/networks.ts`, `bootstrap.ts`, `health.ts`, `isolation.ts`, `isolationState.ts`, `tcp.ts`,
  `src/shared/ingressNames.ts`, `src/modules/deployments/compose/networking.ts`, `groupNetworks.ts`,
  `src/modules/deployments/networkGroupAssignment.ts`
- Mounts and data: `managedVolumes.ts`, `seedVolumes.ts`, `src/modules/maintenance/migrations/`
- nginx: `src/modules/ingress/nginx/`
- Start-up order: `src/index.ts`
- The host: `stackport.sh`, `docker-compose.system.yml`, `Dockerfile`, `docker-entrypoint.sh`

`src/modules/deployments/operations.ts` is not on the list although it calls into the network code: it holds the whole deploy flow, so
every deploy-related PR would need a staging line and "not needed" would become a reflex. If a change to it touches network attachment or start-up order,
add the lines anyway.

The list is `GATED` in [scripts/ci/staging-gate.sh](../scripts/ci/staging-gate.sh); the workflow
`.github/workflows/staging-gate.yml` runs it on every pull request to `main`. Change one place and the other
stays true.

Any row in [1.3/verification.md](1.3/verification.md) that the change touches is run as part of it.

## What to run

On a staging host (a copy of a real install, with several routed projects and Docker's default address pool, or
close to it):

1. `sudo stackport update` to the branch under test.
2. `sudo stackport status`: containers up, health ok, the `networks:` line sensible.
3. For each routed project, open its site, and check **Domains > Routing** says every route reaches its service.
4. The rows of `verification.md` the change touches.
5. If the change touches networks or start-up, repeat step 1 with the address pool nearly used up
   (`for i in $(seq 1 30); do docker network create fill-$i; done`, then remove them), because that is what failed.

## What to put in the pull request

Two lines in the description, which the check looks for:

```
Staging host: sp-staging, 2026-11-10
Result: updated with 28 of 31 networks used; 6 routed projects up, Domains > Routing ok on all
```

If a listed file changed but cannot affect a real host (a comment, a typo, a test-only export):

```
Staging host: not needed: comment-only change in networks.ts
```

A reviewer is expected to read the reason, not just see that the line is there.

## What this does not do

It does not run anything on the host: it checks that someone says they did, and what they saw. The unticked
verification rows are still the list of what has not been seen on a real host; the gate stops new ones being added
silently to the paths that hurt most.
