# Stackport Control (`sp-control/v1`) — design

Status: foundation slice implemented on branch `1.4` (identity, pairing, signed channel, name sync, revoke, rotate). Project operations over the channel and the UI are the next slices. Plan: [roadmap/1.4.md](../roadmap/1.4.md), workstream 2 (ENG-68).

## Model

- Every instance has an immutable `instance_id` and an instance-owned `name` ([modules/backup/instance.ts](../../src/modules/backup/instance.ts)). Only the id is used for authorization and references.
- Relationships are **directional**. Pairing makes instance A a *controller* of instance B. B gets no standing over A, and nothing is transitive. Each direction is its own record:
  - `peer_targets` on A: instances A controls (endpoint, optional pinned certificate, the shared key, grants B gave A).
  - `peer_controllers` on B: instances allowed to control B (the same key, grants, revocation).
- B stays authoritative. A never receives B's database, Docker socket, credentials or secret values; A stores only a display name, an endpoint, a pin and the shared key.

## Transport

HTTPS only (plain http is accepted solely to loopback, for tests and a local proxy). The API lives under `/control/v1`, separate from the session-authenticated `/api` and from MCP. A self-signed peer is handled by pinning its certificate fingerprint in the pairing code; otherwise the normal chain is checked. The pin is verified on a fresh TLS connection **before** any byte of the request is written, so neither the pairing secret nor signed headers reach a server with a different certificate.

## Pairing

1. On B an admin issues a **pairing code** (`POST /api/peers/pairing-codes`): the endpoint A will use, optional certificate fingerprint, the grants A will receive, a lifetime of 1–60 minutes (default 15). B stores only a hash of a random secret. The code, `spp1.<base64url JSON>`, carries B's `instance_id`, endpoint, pin and secret.
2. On A an admin pastes it (`POST /api/peers/targets`). A calls `POST /control/v1/pair` with the secret and its own id and name. B spends the code atomically (single use, unexpired), records A as a controller with a fresh 256-bit key, and answers with its identity, the key and the grants.
3. A checks that the answering instance's id is the one named in the code, and that a protocol version is shared, before storing anything.

The pairing response carries the key, so it is only as trustworthy as the channel: pin or CA-validate. Pairing is rate limited (10 per 15 minutes).

## Requests

Every call after pairing is signed with HMAC-SHA256 over: protocol, method, path with query, caller id, **target id**, timestamp, nonce and the SHA-256 of the body. Headers: `X-SP-Protocol`, `-Instance`, `-Target`, `-Timestamp`, `-Nonce`, `-Signature`, and `-Operation` for mutations.

B refuses, in this order: unsupported protocol (426); a target id that is not B (421 `wrong-target`, so a reused address or IP never acts for the wrong instance); an unknown caller or bad signature (401, indistinguishable); a revoked caller (403 `peer-revoked`, revealed only to a caller that proved it holds the key); a timestamp more than 5 minutes off (401 `clock-skew`); a nonce already seen (401 `replay`, nonces are persisted so a restart does not reopen the window, and a restore records a floor so nothing signed before it is accepted again).

The channel reads its own body (up to 16 kB for now, any content type; the signature covers the body, so it is read before the caller is known), so signatures cover the exact bytes independent of the application's JSON parser.

Once a caller has proved it holds the key, every answer, refusals included, is signed (`X-SP-Response-Signature` over nonce, status and body hash). A believes a `revoked` or "notified" answer only when it is signed, and treats an unsigned or mis-signed answer as **not the peer**, so another server answering at the registered address cannot pass for it. Identity is the instance id, never the hostname; an endpoint change is accepted only if the new address proves the same id with the same key.

## Grants

Chosen by B's admin at pairing, enforced on B (`requireGrant`), audited when denied:

| Grant | Allows |
|---|---|
| `projects:read` | list/inspect projects, status, health, logs, action history |
| `projects:write` | create, configure, deploy, rebuild, stop, restart, roll back, domains and routing |
| `projects:env` | read and edit managed env files, secrets masked |
| `projects:secrets` | reveal secret values |
| `projects:shell` | interactive container shell |
| `projects:destroy` | delete projects and their data |
| `host:read` | *planned:* read-only host metrics and the status snapshot (CPU, memory, disk, load, network) |
| `host:notifications` | *planned:* read the instance's notifications over the live channel |
| `projects:transfer` | *planned:* export or import a project's full data for a move; needs secrets on both sides, never implied by another grant |

Each grant includes what it needs (`secrets` ⇒ `env` ⇒ `read`). Global host administration is **not grantable**. From `projects:write` upward a peer can edit Compose files and run arbitrary containers, which under today's Docker-socket model is host-equivalent: grants are access levels, not a sandbox, and the UI must say so.

## Lifecycle

- **Name sync:** `GET /v1/hello` returns identity, current name, protocol versions and this caller's grants. A calls it every 60 s ([monitor.ts](../../src/modules/peers/monitor.ts)) and on demand; a rename on B appears in A's cache on the next check. A keeps no alias.
- **Connection state** (in memory, last attempt): `online`, `offline`, `revoked`, `identity-mismatch`, `version-mismatch`, `unknown`. Offline peers stay listed and reconnect on their own.
- **Revocation:** B revokes a controller (effective on its next request, A sees `revoked`), or A removes a target, which first tells B (`POST /v1/revoke`) and removes locally even if B is unreachable, reporting `notified: false`. Re-pairing needs a new code.
- **Rotation:** the controller generates the new key and sends it (`POST /v1/rotate`, signed with the old one). The peer switches and treats a repeat of the same key as already done, so a lost answer is recovered by retrying (3 attempts) and the two sides cannot end up on different keys. The old key keeps verifying until the new one is first used (at most 1 hour).
- **Storage:** keys are encrypted with the installation keyring and registered with the re-encryption task. Pairing codes and nonces are runtime state and never in a backup.
- **Backup/restore:** `peer_targets` and `peer_controllers` are level 1. *Recover* keeps them (the peer will see the same instance id and key); *clone* deletes both, so a copy has no standing with the original's peers.

## Not yet built

1. Project operations over the channel (list/create/configure/delete, env, domains, deploy/rebuild/stop/restart/rollback, logs, history) through B's existing services and action locks, with the `requireGrant` checks and operation-id idempotency (a repeated `X-SP-Operation` returns the first result).
2. The live channel (WebSocket) for action progress and logs, with resume after disconnect by event cursor.
3. UI: sidebar entries with connection state, the selected instance shown on every project screen and destructive confirmation, pairing screens, rename.
4. Pairing-code transport hardening beyond TLS (e.g. confirming a short fingerprint on both screens) if needed after real two-host testing.

## Planned: monitoring peers

*Not built.* The peer stays authoritative and keeps its own history; the controller never stores a second copy.

- **Snapshot:** `GET /v1/status` (grant `host:read`) returns the sections the live status stream already builds (host CPU, memory, disk, load and network; project states; running actions; alerts) from the same builder. A fetches it on the existing 60 s monitor (faster while someone is viewing that peer) and keeps the last one in memory with its age.
- **Detail:** charts for a peer are requested from the peer for the chosen range when opened, never replicated. The peer's own retention applies.
- **Live:** running actions and deploy progress arrive over the live channel (WebSocket, resumable by cursor). An offline peer shows its last snapshot marked stale, and reconnects on its own.
- **UI:** a state and an alert dot per peer in the sidebar; a fleet page with one row per instance; an instance selector on Insights, Host and Projects, always showing which instance is selected; running-action toasts and alerts merged across instances, each labelled with its instance.
- **Host-level data** is read-only and has its own grant, `host:read`. Host *administration* stays ungrantable.

### Notifications

Each instance generates its own notifications and is their source of truth. Every notification carries its **originating instance id** and a **UUID**, so anything that consumes both A and B can de-duplicate by UUID. A controller holding `host:notifications` on B **subscribes** to B's notifications over the live channel (with a resume cursor, so a dropped connection loses none) and re-publishes them next to its own, labelled with their origin. Pairing stays directional: B does not call A. B's own email and push settings are unchanged. A raises its own alert only for connectivity (a peer going offline); de-duplication of the rest is the consumer's, by UUID.

## Planned: moving a project between instances

*Not built, and not part of ENG-68's acceptance.* It builds on level 3 backup (a project's workload data) and on the project operations above. "Move to X" is a **copy, verify, then destroy the source**, run as one resumable operation (one operation id, audited on both instances). Version 1 is stop, copy, start: the source is stopped for the copy and the project is down until the move is confirmed.

### The project archive and its transport

1. **The project archive (level 3, one project).** The sealed `SPBACKUP` container holding the project record and Compose snapshot, the managed `.env` with its secret values (re-encrypted under the target's keys on import), uploaded sources and the contents of its volumes (a throwaway container per volume streams a read-only tar). Git checkouts are not copied; they are cloned again. It is also usable by hand: export to a file, import on any Stackport, including an unpaired one. This is also a per-project backup and a clone.
2. **Ticket transport.** The target creates a one-time ticket (its URL, certificate fingerprint, a single-use token and the archive key, valid about an hour, scoped to one import). The controller passes it to the source, which pushes the archive straight to `POST /v1/transfers/:id/chunks` on the target. The controller orchestrates and watches; it is not in the data path. It is one scoped, expiring token, not a standing link between the two instances, so it creates no mesh and no transitivity. The controller does see the ticket, so this reduces exposure and cost, not the trust boundary: moving needs `projects:transfer` and secrets on both sides.
3. Chunks are numbered with a sha256 each, so a retry resumes from the last confirmed chunk.

### Verification: success only after verification

Nothing is called a success, and the source is never destroyed, until all of these hold:

1. every chunk matched its sha256 on receipt;
2. the target re-reads what it **imported** (volume contents, uploaded files, database rows) and computes a digest over that, not over the bytes it received, so a failed or partial write is caught;
3. that digest equals the source's manifest digest, recorded by the source at export time. Both are attested to the controller over their own signed channels; the controller compares them;
4. the project starts on the target and passes its health check;
5. the user confirms.

The source's destroy call carries the verified digest and is refused unless it equals the digest the source recorded for this operation. This guards against bugs and truncated copies; it is not a defence against a malicious controller, which already needs `projects:destroy` to ask.

### Domain

When the user starts a move, the dialog asks for the **new hostname using the target's own domain manager** (`GET /v1/domains`): it pre-selects the project's current subdomain label plus the first managed base domain available on the target, and the user can change it. The target checks the hostname is free and its base is managed, and reserves it. Stackport does not manage DNS: the user creates the record **before** the stop, and the dialog warns if it does not resolve yet. The route and certificate are enabled on the target after the health check. Keeping the exact old hostname is a second choice, offered only when the target manages that base domain; then the DNS repoint is an explicit step.

### Order

1. Preflight on the target: free disk space, name collision, version (the target must be at least as new as the source), hostname availability.
2. The user creates the DNS record for the new hostname.
3. Reserve the hostname and copy what does not change while running: configuration, `.env`, uploads, Compose snapshot.
4. Stop the source and transfer the volumes.
5. Import and start on the target, and verify (above).
6. The user confirms. **That is the commit point:** the source project is destroyed (needs `projects:destroy` on it, and the verified digest). There is no automatic rollback after it, and no retention window, by decision. A project archive exported by hand beforehand is the user's own safety net.

### Failure and rollback

Before the commit point everything is undone, automatically:

- **Source:** back to exactly its original state, which is not always "running". Before anything is touched, the state is recorded: which services were up, and the project's automation (auto-deploy, webhook triggers, health checks). Rollback restores that record.
- **Target:** the partial import is removed: database rows, volumes, files, the reserved hostname, any route or certificate request, and the ticket.
- **Triggers:** any failed step, the user pressing Abort, an expired ticket, a checksum mismatch or the controller disappearing.

Mechanisms:

1. **A move lock on the source** for the whole operation: nothing else can deploy, restart or delete the project, including webhook-triggered deploys and scheduled actions.
2. **A lease on the stop.** The source's own state machine owns it and the controller renews it (about every 30 s). If the controller crashes and the lease lapses, the source restores itself, so a dead controller never leaves a project stopped for good.
3. **Idempotent, retried compensation,** audited under the operation id.
4. **A failed rollback is loud:** the project enters *needs attention* with an alert; it is never silent.
5. **A saga state on both sides** (preparing, copying config, quiescing, transferring, importing, verifying, awaiting confirmation, committed, aborted, failed), so a restart of either instance resumes or compensates.

Between the stop and the confirmation the project is down. An abort in that window restarts the source and drops the target; anything written to the target after it started is discarded, so abort before real traffic has reached it.

## Out of scope in 1.4

Automatic placement, shared databases or volumes, scheduling, full mesh, transitive grants, relays. A one-time, user-started **move** of a project (above) is planned but is not automatic placement and is not part of ENG-68's acceptance.
