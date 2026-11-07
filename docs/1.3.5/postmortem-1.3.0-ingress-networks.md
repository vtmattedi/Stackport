# Postmortem: 1.3.0 took routed projects down (7 November 2026)

**Status:** resolved by 1.3.1. **Severity:** high (a production server lost routing for several projects for about an hour and a half). **Data lost:** none.

Times are UTC; the server and the team are at UTC-3. Where a time could not be recovered from the logs or records, it says so.

## Summary

1.3.0 gave every routed project its own Docker network (S9, `stackport-ingress-<id>`), so nginx could reach a service by a name unique to its project. Docker hands each network a slice of a small, fixed address pool, about 30 networks in all for a default install, and every Compose project already uses one. The production server had 16 projects, which left room for only nine of the new networks. The other seven could not be created (`all predefined address pools have been fully subnetted`), but nginx's regenerated config already named their new addresses, so those seven projects stopped answering. Running containers and data were never touched.

1.3.1 returned to one shared network with unique aliases and removed the per-project networks. It reached `stable` about 90 minutes after 1.3.0.

## Impact

- 7 of 16 projects lost their routes: Mw Web Utils (12), NightMare MQTT (13), Chrono (17), MW-Studycase (18), personal-site (20), tripleA-work (23), TerminalWeb (25). The first report was NightMare MQTT; the owner then found that every managed service was unavailable.
- Deploying a new project, or recreating a project's network, would also have failed while the pool was full, because Docker needs a free slot for each. No such deploy was attempted that we know of.
- Duration: from the first start of 1.3.0 (about 13:05) to confirmed recovery (about 14:40). The exact start of the outage per project cannot be recovered: the health checks run on per-project intervals, and the first failure lines in the application log had scrolled out of the 15 lines that were captured.
- No data loss. No container was stopped, recreated or modified by the failure.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 13:02 | PR #33 (1.3) merged to `main`. Promotion to `stable` finished at 13:08. |
| about 13:05 | The server updated to 1.3.0. At start-up Stackport created per-project networks and moved services onto them. |
| 13:36 | Earliest failure line we have: project 25 `ingress.reconcile.failed`, "all predefined address pools have been fully subnetted". Earlier lines were cut off. |
| by 13:50 | Owner reports `sp-mqtt` down after the update (the report's exact time was not recorded). Stackport shows its containers healthy for 3 weeks and its domain check, last run at 13:50, failing in 30 ms. |
| between 13:50 and 14:07 | Owner reports that every managed service is unavailable. |
| 14:04 and 14:06 | Stackport started again (the second time under a different container id). Each start repeats the failure for projects 12, 13, 17, 18, 20, 23 and 25. |
| 14:07 | Owner connects nginx to the existing ingress networks and reloads. No effect: the missing networks did not exist. |
| after 14:07 | Owner pastes the network listing and the application log. Root cause visible: 33 networks, the 31-slot pool full, nine ingress networks created, seven failed. |
| 14:22 | PR #34 opened (return to the shared network). CI: four jobs pass, the API job fails on a new test that wrote to `/etc/nginx`. |
| before 14:30 | Test fix pushed; CI green. |
| 14:30 | Owner merges the hotfix (PR #35, `f7a73c0`) and promotes it to `stable`. |
| about 14:35 | The server builds and starts 1.3.1 (the build runs while the old version keeps serving). |
| 14:37 | Version 1.3.1 and `/health/ready` confirmed. |
| about 14:40 | Owner confirms connections are restored. |

It was not recorded whether the owner ran the temporary workaround offered at about 14:20 (creating the seven missing networks by hand with explicit address ranges) before the update. It does not change the conclusion.

## What happened, technically

1. Docker's default bridge networks come from `172.17.0.0/16` to `172.31.0.0/16` (fifteen `/16`) and `192.168.0.0/16` split into sixteen `/20`: 31 networks in total. The server showed 33 entries, two of which (`host`, `none`) take no address.
2. Before 1.3.0 the server used 22 slots: one per project, a few for other stacks (`mwnightmaresystem_*`, `nightmarenetwork_*`, `dokimos_default`), `bridge`, Stackport's `stackport_default` and `stackport-proxy`.
3. 1.3.0 added one network per routed project. Nine fit (projects 1, 2, 5, 6, 7, 8, 9, 10, 11). The next ones did not.
4. For the projects without a network, the start-up step stopped at "create the network" and left their services on the old shared network under their plain names.
5. nginx's config is regenerated on every start. It now named services by their new alias (`sp13-mqtt-admin`), which only exists on the per-project network. For the seven projects, nginx could not resolve the name and returned an error at once, which is the "30 ms" in the health check.
6. The failure went to a log file inside the container. `docker logs stackport` showed nothing, and no screen or alert showed it.

## Root causes

1. **A resource limit nobody counted.** The change assumed networks were free. Nothing estimated how many networks a 16-project server already used, and nothing checked the pool before creating more.
2. **The switch was not gated on the move.** The nginx config was changed to the new names regardless of whether a project's service had actually reached the new network. A partial failure therefore became an outage instead of leaving the old route in place.
3. **Unverified on a real host.** S9 had been deferred in the first plan precisely because it "needs a real stack to test". It was built later in a single session, tested only against a fake Docker, and listed in `docs/1.3/verification.md` as unverified, yet it went to `stable` with the rest of 1.3. A fake Docker cannot represent address-pool exhaustion.

## Contributing factors

- **Start-up steps raced.** The nginx config and the network step ran at the same time (`void ensureAppIngress(); void reconcileIngressNetworks()`), so the config could be written before the networks existed.
- **Failures were invisible.** Production logging goes to `/app/logs/app.log` only. The failure was a `warn` there, with no console line, no UI state and no MCP field. Detection relied on the owner noticing.
- **The release gates did not look at routing.** `stackport update` accepts a version if `/health/ready` reports the database, the bundle and the updater. It does not check that the projects' domains still answer. The CI upgrade scenarios use a small stack with a handful of networks.
- **Migration by detaching.** The start-up step also took services off the old shared network once it had put them on a new one, which made a partial failure harder to reverse by simply restarting the old version: rolling back to 1.2 would not have restored the routes either.

## Detection and diagnosis

- Detected by the owner, within about 45 minutes of the update. Stackport's own health check had recorded the projects as down, but nothing raised it.
- Diagnosis took roughly 25 to 30 minutes from the first report to the root cause being visible. Time was lost on a wrong first hypothesis (nginx losing its network connections after being recreated, a real weakness but not the cause here), a log command that looked in the wrong place, and a workaround whose errors were hidden by `2>/dev/null`.
- The Stackport MCP showed container and health state but cannot see Docker networks or the application log, so it could not show the cause.
- The right data came from three commands: the network listing, the nginx upstream names and the application log file.

## What went well

- The failure stayed contained to routing. Containers kept running, nothing was recreated, no data was touched, and the updater built the new version while the old one kept serving.
- Once the cause was visible, the fix, tests and release took about 20 minutes, through the normal path (PR, CI, upgrade scenarios, promotion), with no manual change on the server.
- The fix was verified against a real Docker daemon (a service from the 1.3.0 layout and one from the 1.2 layout moved correctly; leftover networks removed) before release.
- CI caught a flaw in the hotfix's own test before release.

## What went poorly

- The change shipped with its known gap. The verification list named the risk (a stack with many projects) and was not run.
- Alerting depended on a person.
- The first diagnostic guidance pointed at the wrong log and the wrong cause.
- The hotfix's first CI run failed on a test that only passed on Windows (it wrote to `/etc/nginx`), which cost about ten minutes.

## Corrective actions

Done in 1.3.1:

| Action | Where |
| --- | --- |
| One shared network with unique aliases; no network per project | `compose/networking.ts`, `ingress/networks.ts` |
| Services moved on to the shared network first, then off the old one; leftover networks removed | start-up |
| Start-up order: services, nginx config, TCP proxies, clean-up | `src/index.ts` |
| Each project that cannot be put on the network is printed with the reason where `docker logs` shows it | `reconcileIngressNetworks` |
| Docs state that Docker's address pool is a shared limit and how to enlarge it | `docs/1.3/security.md` S9 |
| Tests no longer write to `/etc/nginx` | `tests/setup.ts` |

Still to do (tracked in the 1.3.5 plan):

| # | Action | Why it would have helped |
| --- | --- | --- |
| P1 | **`stackport update` probes routes before accepting a version.** After the swap, request each routed domain through nginx locally and roll back automatically if several answer with a gateway error | It would have rolled 1.3.0 back by itself within a minute |
| P2 | **Ingress health per project** in the UI and over MCP (is nginx on the network, is the service reachable by its alias), and a push notification when a routed project stops answering | Detection in minutes instead of by a person |
| P3 | **Docker network headroom** shown on the System page, in `stackport status` and before an update, with a warning near the limit and the daemon-setting fix | The limit would have been visible before 1.3.0 |
| P4 | **Warnings reach `docker logs`.** In production, log warnings and errors to the console as well as the file | The cause would have been in the first thing anyone looks at |
| P5 | **A pool-exhaustion scenario in the clean-install test** (pre-create about 28 networks, then update and check routing) | CI would have failed on 1.3.0 |
| P6 | **A real-host gate for networking and start-up changes.** Rows in `verification.md` that touch Docker networks, mounts or start-up order are run on a staging host, with the result in the PR, before promotion | The unverified row would have been run |
| P7 | **Per-project isolation, redone safely** (1.3.5): networks from an address range of our own, created and verified before nginx's config switches to them, with the old route kept until then | Brings back S9's isolation without the pool |
| P8 | **Operator runbook.** Where logs are (`/app/logs/app.log`, console for ingress), the three commands that diagnose routing, and what not to hide with `2>/dev/null` | Faster diagnosis |

## Lessons

- A change that creates one of something per project needs a number: how many, and what limit it meets.
- Switch a route only after the destination is confirmed, and keep the old route until then.
- A failure that exists only in a file nobody watches is not handled.
- If a plan says "needs a real stack to test", the change does not go to `stable` until it has had one.
- A fake that cannot reproduce the failure that matters proves little about it.

## Open questions

- Exactly how long each of the seven projects was unreachable. The first start's log lines were not captured.
- Whether the 1.3.0 start-up created all nine networks in the first run or some were created on a later restart. The final state is known; the sequence is not.
- Whether any client (devices on the MQTT port, for example) retried or dropped data while MQTT was unreachable. Stackport has no view of that.
