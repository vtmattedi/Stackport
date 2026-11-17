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
| `projects:transfer` | move a project to or from this instance: every secret and all data travel with it. Implies `projects:secrets`, `projects:env`, `projects:write` and `projects:read`; removing the original also needs `projects:destroy`, which it never implies |

Each grant includes what it needs (`secrets` ⇒ `env` ⇒ `read`). Global host administration is **not grantable**. From `projects:write` upward a peer can edit Compose files and run arbitrary containers, which under today's Docker-socket model is host-equivalent: grants are access levels, not a sandbox, and the UI must say so.

## Lifecycle

- **Name sync:** `GET /v1/hello` returns identity, current name, protocol versions and this caller's grants. A calls it every 60 s ([monitor.ts](../../src/modules/peers/monitor.ts)) and on demand; a rename on B appears in A's cache on the next check. A keeps no alias.
- **Connection state** (in memory, last attempt): `online`, `offline`, `revoked`, `identity-mismatch`, `version-mismatch`, `unknown`. Offline peers stay listed and reconnect on their own.
- **Revocation:** B revokes a controller (effective on its next request, A sees `revoked`), or A removes a target, which first tells B (`POST /v1/revoke`) and removes locally even if B is unreachable, reporting `notified: false`. Re-pairing needs a new code.
- **Rotation:** the controller generates the new key and sends it (`POST /v1/rotate`, signed with the old one). The peer switches and treats a repeat of the same key as already done, so a lost answer is recovered by retrying (3 attempts) and the two sides cannot end up on different keys. The old key keeps verifying until the new one is first used (at most 1 hour).
- **Storage:** keys are encrypted with the installation keyring and registered with the re-encryption task. Pairing codes and nonces are runtime state and never in a backup.
- **Backup/restore:** `peer_targets` and `peer_controllers` are level 1. *Recover* keeps them (the peer will see the same instance id and key); *clone* deletes both, so a copy has no standing with the original's peers.

## Project API for controllers (built)

A controller reaches this instance's projects through `/control/v1/api/<path>`, where `<path>` is the application's own API path (`/projects/5/deploy`, `/domains`, ...). The request is **dispatched in this process into the same routes, services and action runner** the local UI uses ([gateway.ts](../../src/modules/peers/gateway.ts)); nothing is reimplemented, so the two cannot drift and this instance stays authoritative.

- **Default-deny allow-list** of (method, path, grant): `GATEWAY_RULES`. A route that is not on it does not exist to a peer (404, the same answer as an unknown route). Read: `projects:read`. Write (`projects:write`): create, update, deploy, pull, rebuild, restart, stop, pause, roll back, hostnames, routing, TLS and certificates, TCP exposure, deploy trigger, network group, Compose file edit. Env files (`projects:env`): list, create, update and delete, with every value masked unless the caller also holds `projects:secrets`; an edit may say `{ key, keep: true }` for a value it cannot see, which this instance resolves itself, so a masked caller can change one variable without the others ever travelling. A value is never stored in the operations table, and a reveal of clear values is audited (`peer.secrets-read`). Destroy (`projects:destroy`, never implied by another grant): delete a project, stop and purge its data, drop a service's volumes.
- **Not on the list, on purpose:** uploads, webhooks, credentials, host administration, other peers, backups and updates. The controls that keep a Compose file from reaching the host (`compose-policy-enforcement`, `hardening`, `ingress-isolation`) are not project configuration, and `nginxExtraConfig` / `nginxExtraBlocks` (raw directives for the shared proxy) are refused in a body. Actions are visible only when started for a project.
- **The principal** is the controller (`peer:<instance id>`), set in a WeakMap keyed by the in-memory request, which `requireAuth` accepts. A client cannot put a request in that map, so a header or body cannot claim it.
- **Idempotency:** a write needs `X-SP-Operation` (8 to 128 characters). The first request with an id records its answer (`peer_operations`, a week); the same id with the same request returns that answer with `X-SP-Replayed: true` and runs nothing; the same id with a different request is `409 operation-conflict`; one still running is `409 operation-in-progress`; one that never recorded (a crash, more than 10 minutes) is `operation-outcome-unknown`: check the state, then use a new id. Answers that mean "try again" (409, 429, 503) are not recorded, so a retry can run once the cause is gone.
- **Audit:** each write is audited on this instance with the caller, the operation id, the status and the grant; a denied request is audited too.
- **Controller side:** `/api/peers/targets/:id/api/...` (session-authenticated) signs and forwards, and passes the peer's own status and body back. A peer's 401 becomes a 502 (it must not sign an admin out of their own instance); an unsigned answer is never taken as the peer; a stored action output is always served as `text/plain`.
- Limits: the signature covers the body, so it is read before the caller is known and is capped at 16 kB. Uploading source files does not fit and is not offered through the channel yet.

## Not yet built

1. Over the channel, still missing: source uploads (the body cap does not fit them) and an interactive shell (it needs the live channel). Everything else in the allow-list above is built.
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

## Moving a project between instances

*Built (version 1: stop, copy, start), beyond ENG-68's acceptance.* Code: `src/modules/moves/` (`transferIn.ts` the target, `moveOut.ts` the source, `ticketPush.ts` the push), `src/modules/peers/moveOrchestrator.ts` (the controller), `movesRouter.ts` (the control routes), `client/src/components/MoveProjectDialog.tsx` and `MoveProgress.tsx` (the UI: a project's Settings tab, a peer project's Settings tab, and Instances > Moves). Either side may be this instance or a paired peer; the same steps run against both through one interface. What differs from the plan below is stated in each section as *As built*. It builds on level 3 backup (a project's workload data) and on the project operations above. "Move to X" is a **copy, verify, then destroy the source**, run as one resumable operation (one operation id, audited on both instances). Version 1 is stop, copy, start: the source is stopped for the copy and the project is down until the move is confirmed.

### The project archive and its transport

1. **The project archive (level 3, one project).** *Built* (`src/modules/backup/projectArchive.ts`; `stackport backup --project ID`, `stackport project-import FILE`). What it carries today: the project's configuration (a fixed list of columns; credentials, the GitHub App installation, the webhook, TCP exposures and nginx routes are not carried and are listed in the archive as such), its env files with secret values, its uploaded source, and the files of its **managed directories** (`<data>/volumes/<id>`, where Stackport keeps writable bind mounts), including empty directories, modes and ownership (ownership is restored only when the importing process may chown, and a warning says when it could not). **Volumes (built):** with Docker reachable, a short-lived container running as root from Stackport's own image (no network, only the capabilities tar needs; nothing is pulled) tars the managed directory and every Docker named volume of the Compose project with owners and modes intact (`src/modules/backup/volumeEngine.ts`), and the importer untars into a new volume carrying the Compose project and volume labels, so Compose adopts it. A volume is verified by a **tree digest** computed inside the helper on both sides (every file's content hash, mode, owner and size, directories, links; never times), not by tar bytes, which are not reproducible. A project whose containers are running is refused (`--allow-running` overrides, with a warning that the copy may be inconsistent). Without Docker access the archive holds only files Stackport can read, and says so. The archive's tars are staged on disk on both sides (twice the data, for now). The manifest is written last, because every hash is taken while the file is written, in one pass. The importer refuses a name that exists, stages and checks every file against the manifest, creates the project, then **re-reads the rows and the files it wrote** and compares a SHA-256 content digest with the manifest's; on any mismatch or error it removes the rows and the directories it created (never a directory that was already there). Raw nginx directives are applied only when the importer allows it, and never over the control channel. Design as planned: The sealed `SPBACKUP` container holding the project record and Compose snapshot, the managed `.env` with its secret values (re-encrypted under the target's keys on import), uploaded sources and the contents of its volumes (a throwaway container per volume streams a read-only tar). Git checkouts are not copied; they are cloned again. It is also usable by hand: export to a file, import on any Stackport, including an unpaired one. This is also a per-project backup and a clone.
2. **Ticket transport.** The target creates a one-time ticket (its URL, certificate fingerprint, a single-use token and the archive key, scoped to one import). *As built:* valid 8 hours until the first chunk (the source is stopping the project and writing the archive, which takes as long as the data is large), then 1 hour after each chunk; the source holds only the ticket for that instance. The controller passes it to the source, which pushes the archive straight to `POST /v1/transfers/:id/chunks` on the target. The controller orchestrates and watches; it is not in the data path. It is one scoped, expiring token (`PUT /control/transfer/:id/chunks/:n`, 8 MB chunks, each with its SHA-256, a repeat of the last chunk accepted once, `complete` checks count, size and the SHA-256 of the whole; only wrong tokens count against the rate limit), not a standing link between the two instances, so it creates no mesh and no transitivity. The controller does see the ticket, so this reduces exposure and cost, not the trust boundary: moving needs `projects:transfer` and secrets on both sides.
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

### As built: who holds what, and how each side undoes itself

- **Target** (`transferIn.ts`, table `project_transfers_in`): prepare (name and hostname free, space), receive, import with `requireVerified`, start (a normal deploy, then publish routes; the hostname starts **without TLS**), commit or abort. The archive holds every secret, so it is deleted as soon as it is imported or fails. A ticket that expires, a transfer a restart cut short, and a copy nobody has kept alive for 30 minutes are removed.
- **Source** (`moveOut.ts`, table `project_moves_out`): the move **holds the project's action slot** (a deploy, restart, webhook deploy or the delete route finds it busy), pauses automation, stops the project, archives it (refusing if containers still run), pushes, and waits. A **lease** (90 s) is renewed by the controller; if it lapses, if the controller aborts, or if this instance restarts, the project is given back: paused state as recorded, started again only if it was running. A restore that fails is `needs-attention`, audited and logged at error level, never silent. The destroy (`commit`) needs `projects:destroy` and the digest the source recorded.
- **Controller** (`moveOrchestrator.ts`, table `peer_moves`, in-process): prepare, copy, import and verify, start and health, then asks the user. It compares the digest the source recorded with the one the target recomputed from what it wrote, keeps the source's lease and the target's keep-alive running, watches the source while the user decides (a source that took the project back cancels the confirmation), and treats several failed polls in a row, not one, as a failure. It is not in the data path and not the safety net: if it disappears, the source's lease and the target's silence timeout undo both sides.
- **Commit order:** the target commits first (the copy is then the project's home), then the source is destroyed. A target that does not answer the commit is looked up before anything is undone; a source that refuses (digest, lease, state) leaves both copies and says so, in `needs-attention`. Once the commit has begun there is no abort.
- Not yet: a version check beyond the schema at import, a DNS check (the dialog warns), the live channel (progress is polled), and carrying a project's TLS certificate (issued again).

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

Automatic placement, shared databases or volumes, scheduling, full mesh, transitive grants, relays. A one-time, user-started **move** of a project (above) is built, but is not automatic placement and is not part of ENG-68's acceptance.
