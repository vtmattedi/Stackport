# Security boundaries and deferred hardening

**Status:** current limitations and deferred options, not a complete or frozen security design. Validate against source and deployment configuration before implementing changes.

## Docker daemon access (historical S11; deferred)

Stackport currently mounts the host Docker socket. Code execution in the Stackport management container is therefore effectively **root-equivalent on the host**. Compose policy restrictions reduce accidental danger but **do not** create a hard multi-tenant security boundary for hostile workloads or agents with arbitrary execution privileges.

Previously considered alternatives:
- A filtering Docker API/socket proxy with an explicit allowlist;
- Docker user-namespace remapping;
- Rootless Docker or separating privileged host operations into a constrained helper.

Any design must account for self-update and recovery: the current updater uses Docker to launch a helper that can access the host filesystem and run the host CLI. An isolation approach that disables recovery is not acceptable. Threat-model the combined powers of arbitrary Compose editing, credential access, volume mounts and Docker operations. This is **not included in the committed 1.4/1.5 scope**; decisions and validation still required.

## Cloud metadata and LAN egress (historical S10; deferred)

Managed workloads may be able to reach `169.254.169.254` (provider metadata credentials) and private/LAN ranges. A host-managed `DOCKER-USER` policy was proposed, installed and repaired idempotently from `stackport.sh`, with metadata blocked by default and private-range blocking potentially opt-in. This requires a real Linux host for verification, rules that avoid breaking intended network groups, host management, DNS and outbound integrations, and explicit cleanup on uninstall.

**Do not describe metadata/LAN egress as blocked until the host rules are implemented and verified.**

## Existing installations and permissions

Some Compose policy/hardening/managed-volume controls were introduced after earlier Stackport installations; migration choices may differ across projects. Treat repositories and privileged remote peer operations as trusted until an inventory proves the effective restrictions. **Full Stackport Control in 1.4 is deliberately trusted-peer management, not a sandbox for untrusted agents.**

See [technical overview](../../Stackport.md), [1.4 roadmap](../roadmap/1.4.md), and [1.3.0 incident](../incidents/1.3.0-network-outage.md). Detailed past implementation analysis remains available via Git history.
