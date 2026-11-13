# Stackport 1.3.11

Started 12 November 2026, from 1.3.10 (this branch is stacked on it: merge 1.3.10 first, or both land together).

## Decided

- **A secured WebSocket exposes the live status** ([live-status.md](live-status.md)): host CPU, memory, disk and network; every project's state; the actions running now; alerts
  ("something is wrong with X", the kind Insights shows as Needs attention); and, per project, the p95 response time and the 5xx rate. It only sends. A separate adapter connects to it and
  does the MQTT. There is no MQTT code in Stackport.
- **Security is the design, not a layer on it.** Off until an admin turns it on; its own `status` token scope that cannot call MCP (and that MCP tokens cannot use); header-only tokens;
  HTTPS only (or this machine); no browsers (Origin refused); receive-only; connection, failure and buffering limits; tokens re-checked every 30 s so a revoked token loses its connection;
  a token can be limited to a project group, which then sees no host data; and a payload built field by field so nothing leaks by being added to a table. The table in live-status.md names the test behind each.
- **Settings > Live status**: turn it on and off, the address to connect to, who is connected, and the tokens for adapters. The MCP page lists only MCP tokens now.
- **Alerts are conditions that hold now**, with a stable id, not events. The deploy-failure rule looks at a project's *latest* deploy in the last 24 hours (Insights lists every failure in 30 days,
  including ones a later deploy fixed); that is a deliberate difference.
- **Project state moved to the server** for the stream; a test runs the web UI's own function on the same facts, so the two cannot drift.

- **MCP can read container logs, for tokens created with log access.** The MCP page has always said read tokens never expose logs, because an app can print anything. So this is opt-in per token
  (a switch when the token is created; existing tokens gain nothing), adds one tool, `stackport_get_project_logs`, and a token limited to a project group reads only that group (a project outside it
  gets the same answer as one that does not exist). Secrets Stackport manages (stored credentials and the project's env values) are masked before the text is cut to size, so a secret straddling the
  cut cannot survive in half; terminal escape sequences and control characters are removed; the output is capped (10 to 500 lines per container, 64 KiB, the most recent kept); the service name is checked against
  Compose's naming rules before it reaches a command line; a token may read logs 10 times a minute; every call is audited with the token as actor (the log text never is). The result says the text is data
  written by the app, not instructions. Masking cannot catch a secret an app prints that Stackport does not manage; the switch's hint says so.

- **A percentage estimator for running actions**, one function feeding both the status stream and the web UI. A Docker build is weighed by phase (preparing 0 to 5, pulling 5 to 15, building 15 to 75 following
  its "step n of m", deploying 75 to 90, starting 90 to 95); any other action (an Nginx apply, a certificate, a prune) by how long the last successful runs of the same kind took, with the time left. It never goes
  down for an action, never claims more than 95% while running, and gives `null` rather than a guess when it has no basis (no build phase and fewer than 3 earlier runs). Before this, only Docker builds had a number,
  and it covered only the build step (it sat at 0 through pulling and at its last step through deploying). The stream's `actions[]` now carries `phase`, `percent`, `etaSeconds` and `basis`; its old `progress` field was
  documented as 0 to 100 but held a 0 to 1 fraction rounded to a whole number, so it was always 0 or 1: that was a bug in this branch, fixed by the rename. The UI gets an `action:progress` event every few seconds
  while a number changes; the running-actions list and the build toast show "~45% · about 40 s left".

## Review

A code review of the stream found, and this release fixes: a request such as `GET //h:99999` with an Upgrade header made `new URL` throw in the server-wide `upgrade` listener, which would have ended the process (the test now sends such targets and fails on any uncaught exception, and was run against the old code to confirm it fails there); an empty snapshot sent when nothing could be collected (now closes with 1011, and the heartbeat carries `dataAgeS`); a throwing listener or a stalled collector stopping later updates; the revalidation timer throwing on a closed database; a group name longer than 80 characters (or with extra spaces) matching nothing; a failed Nginx check raising a critical alert; and "0 of 0 containers" with Docker down.

## Tested

- `tests/statusStream.test.ts` (23): every refusal and limit above, against a real HTTP server and a real WebSocket client; the hub (`tests/statusLogic.test.ts`, 34: project state against the UI's, request statistics, alerts, scoping, what is sent and when).
- `npm run e2e:status` starts the real `src/index.ts` and drives the real admin API and a real WebSocket: off by default, enable, token, refusals, data, Socket.IO still working beside it, off disconnects.

## Not verified

- **Behind the real Nginx container on a server.** The TLS rule depends on the proxy saying `X-Forwarded-Proto: https`; Stackport's generated block does, and the logic is tested, but a `wss://` connection through the real Nginx and a real certificate has not been made.
- **The p95 and 5xx numbers against a real access log.** They are computed by the same parser Insights uses and tested on lines I wrote; the numbers from a server under traffic have not been compared with Insights'.
- **Slow consumers.** The buffer cap is in the code; it is not exercised by a test (it needs a client that stops reading).
- The Live status page was looked at in the screenshot harness only.
- **The estimator against real builds.** The arithmetic, the history query (on a real database) and the ticker are tested; how close the percentages track real builds and deploys has not been measured, and the first few runs of a kind have no history, so only Docker builds have a number until three have succeeded.
- **The log tool against a real Docker Compose project.** Its logic is tested with the log source replaced (masking, caps, scope, rate, service checks, who gets the tool); the real `docker compose logs` call is the one the project page already uses, and was not run through MCP here.

## Planned, not built

- Configurable alert thresholds (per project).
- An example adapter (WebSocket to MQTT) in `docs/` or a separate repository.
