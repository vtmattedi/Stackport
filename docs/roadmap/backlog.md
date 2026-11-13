# Unscheduled Stackport engineering backlog

These are **historical proposals or open follow-ups**, not v1.4/1.5 commitments. Confirm each item against current code and Linear before acting; some older notes may now be obsolete.

- **A1** — deploy a prebuilt image pinned by digest, with the same Compose policy protections as repository builds.
- **A3** — consider blue-green deployments/build-before-swap to reduce in-place replacement outages; requires service/data compatibility rules.
- **MCP-2** — OAuth for remote MCP connectors (authorization code/PKCE/discovery) remains separate from the dedicated Stackport Control channel.
- **U4b** — show managed/external volume mappings on project pages, with correct host paths and permissions.
- **B1** — pin the chosen deployment revision across rollback preview and confirmation to avoid TOCTOU.
- **B2** — review Nginx WebSocket/upgrade connection headers and ordinary upstream keepalive.
- **B3** — bound GitHub ETag/polling cache.
- **B4** — allow a selected deployment branch from the command palette.
- **N1** — review public `/version.json` exposure of the exact Git commit; consider an opaque revision token.

**Excluded here:** scheduled off-host backup automation is explicitly [deferred to 1.5 or later](1.5.md). Security S10/S11 are documented in [security boundaries](../engineering/security-boundaries.md). Product backlog and progress are tracked in [Linear](https://linear.app/mattediworks/project/stackport-04b39996d8cf).

Historical source: removed `docs/1.3/backlog.md` and `docs/1.3/security.md` (available through Git history). Do not create implementation tasks solely from outdated status notes.
