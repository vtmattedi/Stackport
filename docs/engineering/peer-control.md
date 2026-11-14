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

B refuses, in this order: unsupported protocol (426); a target id that is not B (421 `wrong-target`, so a reused address or IP never acts for the wrong instance); an unknown caller or bad signature (401, indistinguishable); a revoked caller (403 `peer-revoked`, revealed only to a caller that proved it holds the key); a timestamp more than 5 minutes off (401 `clock-skew`); a nonce already seen (401 `replay`, nonces are persisted so a restart does not reopen the window).

The channel reads its own body (up to 5 MB, any content type), so signatures cover the exact bytes independent of the application's JSON parser.

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

## Out of scope in 1.4

Automatic placement, shared databases or volumes, scheduling, full mesh, transitive grants, relays.
