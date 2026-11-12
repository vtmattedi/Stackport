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

## Planned, not built

- Configurable alert thresholds (per project).
- An example adapter (WebSocket to MQTT) in `docs/` or a separate repository.
