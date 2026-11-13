# Live status stream

A WebSocket at `/status/ws` that streams what an adapter needs to know about this Stackport: the host's CPU, memory, disk and network; every
project's state and traffic; the actions running now; and alerts. It only ever sends. What the adapter does with it (publish to MQTT, draw a
dashboard) is the adapter's business and is not in Stackport.

Turn it on in **Settings → Live status**, create a token with the dedicated `status` scope, and connect with it. A normal MCP `read` or `write` token cannot access this stream.

The `hello.instance` value is a randomly generated, persisted **live-status stream identifier** (`status_stream_instance` in `app_meta`). It is useful for adapter topics, but is **not** the immutable `instance_id` plus synchronized friendly name planned for [Stackport Control in 1.4](../roadmap/1.4.md). This stream is read-only telemetry, not a peer management connection.

## Connecting

```js
import WebSocket from "ws";

const ws = new WebSocket("wss://YOUR-STACKPORT/status/ws", {
  headers: { Authorization: `Bearer ${process.env.STACKPORT_TOKEN}` },   // a "live status" token; never in the address
});
ws.on("message", (raw) => handle(JSON.parse(String(raw))));
```

Every frame is one JSON object from the server. The client sends nothing; a data frame from the client closes the connection (1008).

| `type` | When | Content |
|---|---|---|
| `hello` | first | `v` (protocol version, 1), `instance` (a persisted random stream ID for topics), `sections`, `scope` (`all` or `group`) |
| `snapshot` | right after hello, once | `seq`, `at`, `data`: all four sections |
| `update` | when a section changes | `seq`, `at`, `section` (`host`, `projects`, `actions`, `alerts`), `data`: that whole section |
| `heartbeat` | every 30 s | `seq`, `at`, `dataAgeS` |

`seq` rises by one per message after hello, per connection. A gap means a message was lost (the server never drops one on purpose; a reader too
slow to keep up is disconnected instead): reconnect and use the new snapshot. An update replaces its section; it is not a patch.

**A heartbeat proves the connection, not the data.** `dataAgeS` is how old the data behind the stream is: a few seconds normally. If it keeps rising, Stackport cannot collect (Docker or the database is failing) and what you hold is stale:
raise your own alarm on it. If Stackport cannot collect at all when you connect, the connection is closed with 1011 instead of sending an empty snapshot, which would read as "no projects, nothing wrong".
The server looks every 10 s while anyone is connected, so a change shows up within about that time.

### Data

```ts
host:     { cpuPercent, memPercent, memUsedMb, memTotalMb, load1, diskUsedPct, netRxBps, netTxBps, sampledAt } | null
projects: [{ id, name, group, state, containers: { running, total }, health, lastCheckedAt,
             traffic: { windowS, requests, serverErrors, errorRatePct, p95Ms } | null }]
actions:  [{ id, kind, projectId, projectName, startedAt, phase, percent, etaSeconds, basis }]
alerts:   [{ id, severity, code, scope, projectId, subject, message, since, value, unit }]
```

- `state`: `ready`, `problem` (running, health check failing), `down`, `not-deployed`, `paused`. The same decision the Projects page makes; a test holds the two together.
- `traffic` covers the last 5 minutes of Nginx's access log, per project, without Stackport's own health checks. `p95Ms` and `errorRatePct` can be `null`; with fewer than 20 requests they are real numbers but the alert rules ignore them, and so should you.
- `actions[].percent` is an **estimate** of how far along a running action is, 0 to 95 while it runs (an action that has finished is simply no longer in the list), with `etaSeconds` left and what it rests on in `basis`:
  `steps` (a Docker build is in its build phase and reports "step 3 of 9"), `phase` (a Docker build, by where it is: preparing, pulling, building, deploying, starting) or `time` (how long the last
  successful runs of this kind of action for this project took, from at least 3 of them). With neither a build phase nor enough history, `percent`, `etaSeconds` and `basis` are `null`: no number is
  better than an invented one. It never goes down for an action. The web UI shows the same numbers, from the same estimator.
- `alerts` are **conditions that hold now**, not events: "something is wrong with X", like Insights' Needs attention. The list is whatever is true at this moment. `id` is stable while the condition lasts
  (`project_down:3`), so an adapter makes events by comparing two lists: a new `id` appeared, an `id` went away. `since` is when Stackport first saw it (it restarts with Stackport).
  The browser push alerts (something expected did not happen) are a different system and are not repeated here.

| `code` | Severity | When |
|---|---|---|
| `project_down` | critical | a container that counts is not running |
| `project_unhealthy` | critical | everything runs, the health check fails; also a project whose last health check failed while Docker is unreachable (its containers cannot be checked, so it is not reported as "down") |
| `project_deploy_failed` | warning | the project's latest deploy failed, in the last 24 h |
| `project_error_rate` | warning at 1%, critical at 5% | 5xx share of the last 5 minutes (at least 20 requests) |
| `project_latency` | warning at 2 s, critical at 5 s | p95 response time over the last 5 minutes (at least 20 requests) |
| `host_disk_low` | warning or critical | Docker's disk is under the storage thresholds (Host > Docker > Disk and cleanup) |
| `host_docker_down` | critical | Docker is not reachable |
| `host_nginx_down` | critical | Docker says the Nginx container is missing or stopped (a check that merely failed, such as a timeout, raises nothing) |

Paused and not-deployed projects raise nothing. The thresholds are fixed in code for now.

## Security

What the stream guarantees, and the test that holds each one (`tests/statusStream.test.ts` unless noted; `npm run e2e:status` checks the same against the real server):

| Risk | What is done |
|---|---|
| An endpoint nobody needs | **Off by default**; while off it answers 404, the same as a page that was never there. Turning it off disconnects everyone at once. |
| A stolen or guessed token | Tokens are 256 random bits, stored only as a SHA-256 hash, looked up by hash. A group-limited token matches a project's group exactly as stored. A token is checked again every 30 s, so a **revoked or expired token loses its connection** (4001) within that time. Failed attempts lock an address out for 15 minutes after 10 (a good token from a locked-out address is refused too). |
| A token in a log | The token is accepted **only in the Authorization header**. An address with a query string is refused outright, so a token cannot be written to an access log by accident. The token and the stored hash are never in a message or an audit entry. |
| The wrong kind of token | A `status` token is its own scope. It does **not** include `read`, so it cannot call MCP; read and write tokens cannot open the stream. (`tests/apiTokenScopes.test.ts`) |
| More access than needed | A status token can be limited to a **project group**: it then sees only that group's projects, their actions and their alerts, and **no host data** (host numbers include other groups' load). (`tests/statusLogic.test.ts`) |
| Plain text | The connection must be **encrypted, or come from the proxy Stackport trusts saying the client used HTTPS, or come from this machine with no proxy in between**. A proxy that says "http", or forwarding headers from a peer that is not trusted, are refused. The client address behind the proxy is taken the same way Express takes it (the first address from the right that is not a trusted proxy), so a client cannot name its own address to dodge the lockout. |
| Cross-site WebSocket hijacking | A request with **any `Origin` header is refused**; an adapter is not a browser. |
| A client that tries to talk back | The server expects nothing. Frames from the client are limited to 125 bytes and any data frame closes the connection. There is no command, subscribe or ping message to get wrong. |
| Resource exhaustion | At most 20 connections overall and 3 per token; a connection whose unsent data passes 1 MiB is cut off instead of held in memory; a connection that stops answering pings is closed; the table of failed attempts is pruned. The data is computed once for all consumers and only while someone is connected. |
| Leaking fields | The payload is built **field by field** into fixed types (`modules/status/types.ts`); a column added to a table does not reach the stream by itself. Env values, logs, paths, hostnames, repository names, commit messages, Nginx extras and credentials are not in it, and a test creates a project with such values and checks none of them appear. Text a person typed (a project's name and group) is stripped of control characters and cut to 80 characters. Alert messages are fixed sentences; they never carry command output. |
| Being the way in | The stream only reads. Nothing on it can start, stop, deploy or change anything. |

Audit log: `status-stream.enable`, `.disable`, and for each connection `.connect` (with the token's name and the address, or the reason for a refusal that was a bad token) and `.disconnect`.

### Behind Nginx

Stackport's own Nginx block already forwards `Upgrade` and `X-Forwarded-Proto` (the web UI's Socket.IO needs the same), and Nginx's default `proxy_read_timeout` of 60 s would drop an idle
connection: the 30 s heartbeat keeps it open. Serve Stackport over HTTPS (Host > Nginx; Settings > Domains) before pointing an adapter at it from another machine. An adapter on the same machine
can use `ws://127.0.0.1:3000/status/ws` with no proxy in between.

## Limits and what is not here

- No replay: after a reconnect the snapshot is the state; there is no history. Insights has the history.
- No per-section or per-project subscription: a token sees what its scope allows, all of it.
- The alert thresholds are not configurable yet.
- A restart of Stackport resets every alert's `since`.
- `projects[].traffic` needs Nginx and Docker to be readable; otherwise it is `null`.
