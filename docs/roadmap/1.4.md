# Stackport 1.4 — portable recovery and peer control (plan)

**Status:** planned, not implemented. Agreed scope, 12 November 2026. No deadlines or implementation PRs have been assigned.

The v1.4 goal is to make Stackport **recoverable across VPSs** and enable **one independent Stackport instance to operate projects on another**. The overlapping Hostinger VPS-1/VPS-2 deployment window (13–20 November 2026) provides a real-host validation opportunity, but it is not a release deadline. Migrating production must not depend on unproven new features: a documented manual fallback is acceptable.

This release has **three large engineering workstreams**. Keep technical subtasks, protocol design, test cases and implementation breakdown in their respective design documents/PRs, rather than creating dozens of Linear issues.

| Workstream | Linear | Result |
| --- | --- | --- |
| 1. Portable backup / restore | [ENG-67](https://linear.app/mattediworks/issue/ENG-67) | Recovery, migration and cloning at three selectable levels |
| 2. Stackport Control | [ENG-68](https://linear.app/mattediworks/issue/ENG-68) | Explicit peer-management channel and full remote project UI |
| 3. Two-instance validation | [ENG-69](https://linear.app/mattediworks/issue/ENG-69) | Real deployment on B from A's interface; migration/restore evidence |

[Stackport Linear project](https://linear.app/mattediworks/project/stackport-04b39996d8cf) · [1.5 plan](../1.5/README.md)

## 1. Portable backup / restore

Stackport currently makes a **control-plane SQLite database backup before its own updates** via `VACUUM INTO`. That is not a portable installation backup and does not include project persistent data. v1.4 defines a manual, verifiable backup and restore operation independent of a Stackport software update.

### Three levels

| Level | Included | Explicitly excluded |
| --- | --- | --- |
| **1 — Configs** | Instance settings and global configuration; administrator identity and **password hash** (never plaintext); relevant credentials/encryption material; global domains, integrations and settings | Project definitions and all project runtime data |
| **2 — Configs + project configs** | Everything in level 1; project records, source/commit/deployment configuration, Compose definitions/uploads, managed `.env` files **including secret values**, domain/routing assignments, health checks and other project settings | Persistent workload data (databases, volumes, uploaded user files, broker state) |
| **3 — Full data** | Everything in level 2; backed-up project persistent volumes/bind mounts, application databases, uploaded user files, broker state and other explicitly enumerated storage | Untracked external resources unless intentionally supported; omissions must be visible and cannot masquerade as complete coverage |

A level-1 or level-2 restore is useful for configuration recovery or re-creation of projects, **not** for recovering application data. Selective backup cannot be implemented by simply copying the whole current SQLite DB and labeling it a lower level: exported project records and secrets must match the chosen level.

### Restore identities and destinations

- **Recover/migrate an installation:** preserve immutable `instance_id`, synchronized `name`, administrator password hash, credentials and the encryption material needed to decrypt them. Invalidate active browser/API sessions; revalidate peer pairings, address/certificate expectations and external integrations before enabling automation.
- **Clone an independent instance:** generate a **new** `instance_id` (same display name is allowed), invalidate all sessions and peer pairings, and do not enable duplicate schedulers, GitHub webhooks, external writers or production workloads automatically. Preserve imported credential decryptability or safely re-key them.
- Initial restore semantics are **replace an installation**, not merge arbitrary project datasets. A restore must have an explicit preview and confirmation when existing state would be overwritten.
- Allow changing host-specific values (public address, hostname, paths, Docker network constraints and certificates) with validation instead of blindly transplanting them.
- Every restore level must be able to work when the web UI is unavailable (CLI / offline restore path), with optional UI entry points for supported operations.

### Backup contract and safety

- Portable versioned format with schema/source version, selected level, manifest of included/excluded components, integrity checks, encryption and verification before destructive application.
- Inventory actual filesystem ownership, including `/etc/stackport`, `/var/lib/stackport`, `/etc/letsencrypt`, project checkouts, declared mounts and any external application data; do not assume every volume is under Stackport's own directory.
- For level 3, quiesce writers or use database-aware/application-aware consistent backups. Filesystem copies of active SQLite/PostgreSQL/broker data are not inherently consistent.
- Graceful error handling for absent/wrong keys, incompatible schemas, corrupt/incomplete archives, unavailable mounts and unsafe target paths. Prefer staged restoration and rollback of the *restore attempt* where feasible.
- State what a backup can and cannot recover; encrypted archives need a documented external key-recovery procedure.

### Acceptance

All three levels can be exported, verified and restored into a disposable installation; level-1/2 correctly exclude runtime data. An administrator can sign into a restored installation using the original password; secrets decrypt. A full backup of a test workload with persistent data restores on another VPS. Cloning never creates a duplicate instance identity or accidentally starts production automations. Invalid archives cannot silently produce a healthy-looking partial restoration.

**Not in 1.4:** scheduled/automatic off-host backup delivery, S3 providers, cross-peer backup orchestration or automated external retention. See [1.5](../1.5/README.md) (deferred candidate).

## 2. Stackport Control — explicit instance-to-instance channel

Every Stackport can **register and manage peers**. There is no master, leader or privileged deployment class; *relationships* and permissions are directional. A managing B does not mean B can manage A, or A can transitively manage C. Each instance remains authoritative for its Docker engine, projects, credentials, operation history and configuration.

### Instance identity and sidebar

Each instance has exactly two identity attributes:
- `instance_id`: immutable and globally unique; **the only identity used for authorization, pairing and persisted references**.
- `name`: configurable, instance-owned friendly display name; synchronized to connected peers on update or reconnect. No additional per-peer alias.

Peers appear in the sidebar, including local instance. Selecting an instance opens the *same* project-management interface backed by that instance. Show connection state and clearly distinguish targets during destructive actions. Duplicate names are allowed; disambiguate with shortened IDs. Hostnames are connection details, not identities; endpoint changes require authenticated identity verification.

### Protocol and security direction

- A **dedicated versioned Stackport Control channel**, distinct from MCP, is the integration contract. A working label is `sp-control/v1`; protocol names/frames are not frozen.
- Candidate implementation: HTTPS request/response management API plus an authenticated live channel (e.g. WebSocket) for action progress/logs and state updates. Pairing must explicitly authorize a remote peer and allow rotation/revocation. B remains the enforcement point.
- Reuse B's existing application services, validation, project action locks and action runner. Do **not** duplicate deployment logic or share Docker sockets, local databases, host credentials or copies of B's secrets with A.
- All mutations use an auditable peer principal, explicit B-side authorization, operation IDs and replay/idempotency protection. Define capability/version negotiation and resume/reconciliation after disconnect.
- Full project control, especially Compose editing, arbitrary workload execution, secrets and container shell, is **highly privileged** and may amount to host control under today's Docker socket boundary. Start with explicitly trusted peers; do not describe partial UI scopes as a sandbox.
- Project management versus **global host/system administration** is an explicit permission boundary. Container shell, destructive actions and secret disclosure need separately authorized access even if project control is broadly enabled.

### Complete remote project management

The target is local/remote **project UI parity**, not a remote deployment button only. From A, managing a project on B must cover: listing/creation/deletion, repository/branch/Compose/upload/configuration, project environment files including `.env`, project domains/routes/TLS, deploy/rebuild/stop/restart/rollback, status/health, logs and action history, and appropriately authorized interactive operations. B persists every change and owns all resulting Docker resources.

Pairing, transport, request schema, secret-access UX, scoped grants, error handling and connection lifecycle need an engineering design before code; these are details **inside ENG-68**, not new top-level issues.

**Out of scope:** shared project databases, placement, automated project replication, cross-host volumes, scheduler/consensus, permanent master, permission transitivity and relays.

## 3. Two-instance and migration validation

Use **independent installations on VPS-1 (A) and VPS-2 (B)** while both are accessible. The exact expiration is a migration constraint, not a reason to merge unverified infrastructure behavior.

**Required end-to-end scenario:** A registers B; B appears under its synchronized name in A's sidebar; from A's *web UI*, create/configure a test project on B, set its managed `.env`, route a domain and deploy it. Observe B's logs/progress/health from A. Verify that B alone owns the resulting containers, network, configuration, deployment history and application data.

Test reconnections, peer revocation, renamed instances, wrong-target protections, operation deduplication, offline behavior, and real secure networking. Rehearse all three backup levels, **recover versus clone** identity behavior, incompatible or partial restores, and a full workload migration with persistent data.

### Production migration is a separate gate

Inventory external dependencies and persistent storage; preserve a consistent, independent recovery copy; keep VPS-1 authoritative until the final cutover; quiesce production writers, transfer remaining changes, start services only on VPS-2, switch DNS/callbacks/TLS as needed, verify operations and only then retire VPS-1. Two active copies must not unknowingly process the same production jobs, MQTT writes, OAuth identity changes or webhooks.

A tested manual migration path is acceptable if parts of 1.4 are not ready. ENG-65 (status scope) and ENG-66 (WS/MQTT transport) remain separately prioritized security/integration issues, not new 1.4 feature work.

## Next release and legacy scope

The old 1.4 plan's **P1 update regression report / infrastructure restore point / Restore** moves intact to [1.5](../1.5/README.md) ([ENG-70](https://linear.app/mattediworks/issue/ENG-70)). It handles *effects of an application update*, distinct from a portable installation backup. Scheduled off-host backups move to a **deferred 1.5-or-later candidate** ([ENG-71](https://linear.app/mattediworks/issue/ENG-71)), not a committed 1.5 feature.

Do not pull unrelated open Stackport backlog work into 1.4 or automatically promise it for 1.5. This is a roadmap/doc-only change; it does not alter the shipping v1.3.11 feature set.
