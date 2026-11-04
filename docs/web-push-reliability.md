# Web Push reliability contract

Baseline: `ac2555cfc24ce57f1940414ac254b6b6e7e85cd9`, branch `feat/web-push-notifications`.

The SQLite outbox is the source of truth for automatic push alerts. Email remains
independent and best effort. Explicit test sends remain immediate. There is one
in-process worker and no additional infrastructure.

## Ownership and invariants

- `notificationTypes.ts`: bounded, versioned event descriptors and lifetime policy.
- `pushOutbox.ts`: synchronous enqueue, deduplication, leases, cancellation and retention.
- `webPush.ts`: identity, preferences, subscriptions and a single-browser transport.
- `pushDeliveryWorker.ts`: polling, bounded concurrency, retry policy and shutdown.
- Domain producers own their short transactions; network probes and sends run outside them.

Health incidents receive an identity once in their state-transition transaction.
Deployment alerts use persisted revision/attempt IDs; rollback failures use an
operation ID captured once at operation entry. Updater outcomes use container ID
and outcome. A failed launch uses the ID of that launch attempt. Repeated
observations of the same incident never allocate another notification identity.

Disabled events and events with no browsers are skipped, without later backfill.
Disabling a channel/event or deleting a browser cancels unsent work, including
leases. Re-enabling affects future incidents only. Recovery cancels only the
matching health episode. Other failures remain relevant until expiry.

| Event | Lifetime and maximum provider TTL |
| --- | --- |
| Health failure | 1 hour; cancel when that episode recovers |
| Blocked automatic deployment | 6 hours; keep the historical explanation |
| Unhealthy deployment | 12 hours |
| Failed automatic rollback | 24 hours |
| Successful automatic rollback | 1 hour; optional UI preference, off by default |
| Failed Stackport update | 24 hours |
| Explicit test | 5 minutes; immediate, outside the outbox |

The worker polls every 5 seconds, claims at most 16 records with 60-second UUID
leases, and sends at most 4 requests concurrently with a 10-second timeout.
Transient failures retry after approximately 15 seconds, 1 minute, 5 minutes,
15 minutes, 1 hour and then at most 2 hours, with 20% jitter and a maximum of
12 attempts. Retry-After is honored within expiry. Every completion checks the
current lease token. Terminal work is retained for 30 days; cleanup uses bounded
batches. A live queue above 5,000 records is reported, without dropping critical
incidents. An 8-second shutdown drain leaves unfinished leases recoverable.

Provider 2xx means **accepted by the push service**, never displayed/read.
Submission is at least once: a crash after acceptance but before the SQLite
completion can cause another attempt. Retries reuse the incident's notification
tag. An HTTP request already in flight cannot be unsent when settings change.

Payloads contain bounded server-created metadata and internal paths only.
Endpoints and subscription keys stay in the subscription table. Errors use
normalized codes, never provider bodies. Restore requires the matching database
and host encryption secret; identity failure never rotates keys silently.
An unavailable signing identity suspends delivery in the retry queue and checks
again every 30 seconds without consuming provider attempts. Repair resumes live
events automatically; expired or cancelled events stay closed. Configuration checks
do not generate repeated delivery failure logs.

Blocked-deployment and unhealthy-deployment email start only after their
classification and eligible push work commit successfully. An unhealthy deployment
keeps its original incident payload;
successful automatic rollback can produce a separate recovery event when enabled
in Settings → Notifications. Recovery never rewrites the original alert.

## Rollout and release gates

Implement as storage, worker, producer, UI/reconciliation, and validation commits.
Migration 007 is additive. Old code can run against the new schema, but cannot
drain an outbox until a worker-capable release returns.

Required automated checks cover transactional failures, distinct incidents,
overlapping probes, leases across connections, stale completions, independent
browsers, retries, expiry, preferences, cancellation, retention, restore drift,
identity failure, service worker behavior, and install/update/rollback persistence.
Run CI and upgrade workflows on the feature PR; do not merge or promote it here.

Real HTTPS push with the tab closed must be checked on Chrome and Firefox before
promotion. Simulated browser/provider checks do not satisfy that release gate.

Implementation checkpoints are committed separately: schema/outbox, worker,
transactional producers, browser recovery/status, and race/regression hardening.
Automated checks include native SQLite connections, forced write failures,
deterministic transport outcomes, service worker VM checks and lifecycle fixtures.
The lifecycle fixture holds a synthetic lease with push disabled; it proves volume
persistence without contacting a real push provider. Retention catches up in
200-record batches once per minute when a backlog remains, otherwise daily.

Manual release validation remains mandatory: real HTTPS provider submission and
actual notifications with the tab closed in Chrome and Firefox. Keep the PR draft
and do not promote merely because mocked provider or CI checks pass.
