# Backend modules

The backend is a modular monolith: one process and database, with source files
grouped by capability. This layout separates ownership without introducing new
services, builders, configuration, or database migrations.

## Layout and ownership

| Location | Responsibility |
| --- | --- |
| `src/modules/projects` | Project records, configuration, workspaces, and environment files |
| `src/modules/deployments` | Deploy, rollback, health gates, revision history, uploads, and Compose preparation |
| `src/modules/automation` | Automatic deployment, GitHub polling/hooks, and script webhooks |
| `src/modules/ingress` | Domains, nginx configuration, certificates, TCP exposures, and the per-project ingress networks |
| `src/modules/notifications` | Event creation, email, browser push, outbox, subscriptions, and delivery worker |
| `src/modules/actions` | Action ownership, logs, and build progress |
| `src/modules/observability` | Host/project snapshots, sampling, metrics, and log routes |
| `src/modules/identity` | Installation/bootstrap, sessions, API/setup tokens, authentication, and admin routes |
| `src/modules/credentials` | Credential routes and record types |
| `src/modules/containers` | Container shell and log operations |
| `src/modules/maintenance` | Self-update, readiness, version reporting, Docker storage maintenance, and the temporary one-off data migrations behind Settings > Migrations (`maintenance/migrations`, to be deleted once installs have run them) |
| `src/integrations/docker` | Shared Docker queries, resource classification, and container references |
| `src/transports` | Socket.IO and MCP protocol adapters |
| `src/application` | Composition across capabilities, including project/system HTTP routers and realtime wiring |
| `src/shared` | Cross-cutting logging, encryption, safe paths, caching, audit storage, and text diff helpers |
| `src/config`, `src/migrations` | Process configuration, database lifecycle, and schema migrations |

`src/index.ts` and `src/app.ts` remain the process and HTTP assembly entry points.
CLI and updater self-test entry paths also remain stable. Capability-owned routes
stay beside their operations. The project and system routers currently orchestrate
several capabilities, so they live in `application/http` rather than claiming
ownership of every operation they expose.

## Imports

- Import the owning file directly, for example `modules/notifications/push/outbox`.
  Modules do not have broad barrel exports.
- New implementations belong in the capability, integration, transport, or
  application directory that owns their behavior. Reserve `shared` for helpers
  with actual cross-capability use.
- Application composition may wire several capabilities together. Existing
  cross-capability calls remain explicit; this migration does not establish
  isolated aggregates or forbid every dependency between capabilities.
- Keep runtime dependencies acyclic. Use type-only imports for type dependencies.
- Do not import the legacy compatibility directories from application code.

`tests/moduleBoundaries.test.ts` checks relative static imports and re-exports for
cycles, legacy dependencies, and export-only compatibility files. It does not
analyze computed imports or dynamically loaded modules.

## Compatibility and migration

The old `routes`, `entities`, `middleware`, `mcp`, and `utils` paths
contain direct exports from their new owners. They preserve external scripts and
compiled entry paths such as `dist/mcp/server.js`. They contain no independent
state or initialization; old and new imports resolve to the same implementation.
Tests cover router identity; the compiled MCP entry is also exercised against the
production image.

`src/services` has been removed. Its consumers now import the canonical owners;
old `dist/services/*` imports are no longer supported. Repository upgrade tooling
recognizes both historical and module-based layouts when testing older releases.

Tests and internal imports use the canonical locations. Keep compatibility files
until consumers of old source/compiled paths have been inventoried and migrated;
remove them in a separately reviewed change. Add functionality only at canonical
paths.

The move preserves implementation bodies and contracts. The two deeper runtime
file lookups in maintenance (package version and bundled UI readiness) were
adjusted to reach the same root files. No tables, persisted identities, event
payloads, permission checks, UI options, or deployment policies change here.

Further work can separate the large deployment workflow and HTTP orchestration,
coordinate web/stdio scheduling across processes, and improve filesystem/database
compensation. Those changes need their own behavior and failure-path review;
placing files in modules does not resolve those concerns by itself.
