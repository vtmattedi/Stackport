# StackPort Dockerization

## Purpose

This document defines the planned Dockerization of StackPort and the architectural gates that should guide implementation.

It is not only a deployment migration plan. The Dockerization changes the boundary between:

- the StackPort control plane;
- StackPort-owned infrastructure;
- user-managed workloads;
- the VPS host operating system;
- external VPS/provider APIs.

The goal is to make StackPort easier to install, upgrade, roll back, recover, and reason about without weakening the central product assumption:

> StackPort is a VPS control plane and is intentionally allowed to exercise powerful administrative control. Managed workloads must not inherit that authority.

This document should be used as:

- implementation guidance;
- a scope-control document;
- a review checklist;
- a release gate;
- a sanity check when architectural decisions are ambiguous.

---

# 1. Current State

Today StackPort is installed directly on the host.

The current model is approximately:

```text
Host OS
├── StackPort
│   ├── Node/Express backend
│   ├── React frontend
│   ├── SQLite
│   ├── Docker access
│   ├── nginx management
│   ├── Certbot management
│   └── host monitoring
│
├── systemd
├── Docker Engine
├── nginx
├── Certbot
└── user project containers
```

StackPort runs as an unprivileged `stackport` user and receives narrowly scoped privileged access for required host operations.

Existing functionality includes, among other things:

- GitHub-backed and uploaded Compose projects;
- project deploy/build/recreate/stop operations;
- project environment-file management;
- Docker container logs and interactive shells;
- nginx generation, validation, backup, rollback, and reload;
- certificate issue/renew/delete;
- project health checks;
- GitHub auto-deploy polling;
- host and container metrics;
- external VPS-provider integration;
- provider firewall integration in an incomplete state;
- StackPort self-update and manual recovery paths.

The Dockerization must preserve the mature parts of the current lifecycle while intentionally replacing infrastructure assumptions that no longer make sense.

---

# 2. Product Model After Dockerization

Post-Dockerization StackPort should have one product/codebase with optional host capabilities.

The product-facing distinction may be:

```text
StackPort Core
StackPort Full
```

Internally, however, there should still be only:

```text
StackPort
+
optional Host Agent
```

Do not create separate Core and Full codebases, forks, installers, frontends, or long-lived product branches.

Feature availability should be determined by runtime capabilities.

---

# 3. Architectural Principle

Use this rule whenever deciding where a capability belongs:

> If it can be implemented entirely through Docker and StackPort-owned containers, it belongs in StackPort Core.

> If it requires authority over the host operating system outside Docker, it belongs behind the StackPort Host Agent and therefore becomes a StackPort Full capability.

Examples:

| Capability | Core | Host Agent / Full |
|---|---:|---:|
| Project deployment | Yes | No |
| Docker Compose lifecycle | Yes | No |
| Project logs | Yes | No |
| Project shell | Yes | No |
| Container metrics | Yes | No |
| Docker networks | Yes | No |
| Docker volumes | Yes | No |
| Reverse proxy | Yes | No |
| TLS certificate management | Yes | No |
| Domains | Yes | No |
| Health checks | Yes | No |
| Git deploys / polling | Yes | No |
| Local firewall | No | Yes |
| Host network configuration | No | Yes |
| Host reboot/shutdown | No | Yes |
| OS package operations | No | Yes |
| Docker daemon configuration | No | Yes |
| Host service management | No | Yes |
| Authoritative host metrics | Eventually | Yes |

Some host information may be obtainable from a container during Phase 1, but once the Host Agent exists it should become the authoritative source for true host-level data.

---

# 4. System Plane vs Workload Plane

Dockerization must introduce an explicit distinction between StackPort-owned infrastructure and user workloads.

## 4.1 System Plane

System resources include at minimum:

```text
StackPort
nginx
certificate manager / Certbot
```

Potential future system resources may include:

```text
metrics helpers
update helper
other StackPort-owned infrastructure
```

These are not projects.

They must not be treated as normal workload containers by generic project APIs.

## 4.2 Workload Plane

User-managed workloads include:

```text
application containers
databases
Redis
workers
queues
other services defined by managed project Compose files
```

## 4.3 Required distinction

Do not implement the distinction only as a UI convention.

Do not rely only on a Docker label such as:

```yaml
stackport.system: "true"
```

Labels may be useful metadata, but they are not the authoritative security or lifecycle boundary.

StackPort must maintain authoritative knowledge of which resources belong to the system plane.

Generic project operations must reject system resources.

At minimum, system resources should not receive generic workload actions such as:

- interactive shell;
- delete;
- delete volumes;
- arbitrary compose down;
- arbitrary compose editing;
- force rebuild;
- project reassignment.

System resources may have their own limited operational actions:

- status;
- health;
- logs;
- restart;
- version;
- controlled update.

---

# 5. Security Boundary

The intended security relationship is:

```text
StackPort administrator
        │
        ▼
Intentional VPS control
```

That is expected.

The important boundary is:

```text
Managed workload
       │
       X
StackPort system plane
       │
       ▼
VPS authority
```

A user having root inside a managed workload container must not automatically imply:

- root on the VPS;
- Docker daemon control;
- access to StackPort;
- access to system-plane secrets;
- access to unrelated project networks;
- access to nginx/Certbot control data.

---

# 6. Compose Security Policy

Dockerization must add a workload policy layer before executing project-supplied Compose definitions.

StackPort currently executes Compose files as a core deployment primitive. In the Dockerized model this becomes a critical trust boundary.

Before:

```text
docker compose up
```

StackPort should resolve/normalize the Compose definition and validate it against policy.

Default workload policy should reject or gate at least:

```text
privileged: true

/var/run/docker.sock mounts

host root mounts
/:/host

sensitive host mounts
/etc
/proc
/sys
/run
/dev where inappropriate

network_mode: host
pid: host
ipc: host

dangerous devices

dangerous cap_add values

attachment to StackPort system networks
```

The exact policy may evolve, but the rule must remain:

> Workloads are untrusted relative to the StackPort control plane.

A future trust model may support:

```text
standard workload
trusted workload
system workload
```

but privilege escalation must always be explicit.

---

# 7. Networking Model

The Dockerized architecture should move away from host-published ports for normal projects.

## 7.1 Current-style routing

```text
Internet
   │
   ▼
Host :443
   │
   ▼
nginx
   │
   ▼
Host-published project port
   │
   ▼
project container
```

## 7.2 Target routing

```text
Internet
   │
   ▼
Host :80 / :443
   │
   ▼
nginx container
   │
   ▼
project edge network
   │
   ▼
project service internal port
```

Normal projects should prefer:

```yaml
expose:
  - "3000"
```

rather than:

```yaml
ports:
  - "8372:3000"
```

The target state is that only deliberate system ingress normally publishes public host ports.

Typically:

```text
80
443
```

and SSH remains host-managed.

---

# 8. Network Isolation

Do not attach all workloads to one shared ingress network.

Avoid:

```text
stackport-ingress
├── nginx
├── project-a
├── project-b
├── project-c
├── postgres-a
├── postgres-b
└── ...
```

Prefer per-project network boundaries.

Example:

```text
sp-control
├── StackPort
└── nginx

project-a-edge
├── nginx
└── project-a-web

project-a-internal
├── project-a-web
└── project-a-db

project-b-edge
├── nginx
└── project-b-web

project-b-internal
├── project-b-web
└── project-b-db
```

Desired default relationships:

```text
nginx → project ingress service      allowed

project frontend → own backend       as configured

project backend → own database       as configured

project A → project B                denied by default

project → StackPort control plane    denied by default

project → system network             denied by default
```

---

# 9. nginx in Core

nginx becomes part of the StackPort system stack.

It is no longer a host-installed service managed through host systemd.

StackPort remains responsible for:

- generated proxy configuration;
- domain routing;
- validation before activation;
- config history/backup;
- rollback on invalid or failed activation;
- safe reload.

The implementation changes, but the operational guarantees should remain.

Target relationship:

```text
StackPort
   │
   ▼
nginx system container
```

No host `systemctl reload nginx` should be required in Core.

---

# 10. Certificate Management in Core

Certificate management should also become part of the system stack.

The Dockerized architecture should prefer decoupling certificate issuance from direct nginx configuration mutation.

Target model:

```text
Certbot / certificate container
        │
        ├── writes ACME challenge
        └── writes certificates

nginx
        │
        ├── serves ACME challenge
        └── reads certificates
```

A webroot-style issuance sequence is preferred:

```text
Add domain
   ↓
Generate HTTP route
   ↓
Reload nginx
   ↓
Issue certificate
   ↓
Certificate becomes available
   ↓
Generate HTTPS config
   ↓
Validate
   ↓
Reload nginx
```

This preserves the safe two-stage issuance behavior already present in StackPort while removing dependency on host nginx/Certbot integration.

Certificates must persist independently of container lifecycle.

---

# 11. Firewall Direction

The existing firewall integration should be disabled or frozen during Dockerization.

Reasons:

- the implementation is not complete;
- provider firewall rules are already available externally;
- Docker changes the effective networking/firewall model;
- keeping several incomplete control paths creates conflicting sources of truth;
- local firewall management belongs naturally with the future Host Agent.

Firewall management should be reintroduced only after the Docker networking model is stable.

---

# 12. Future Firewall Model

StackPort Full should eventually support layered firewall enforcement.

```text
Internet
   │
   ▼
Provider firewall
   │
   ▼
Host firewall
   │
   ▼
Docker networking
```

The desired model is not three independent configurations.

Use one StackPort desired policy with scope-aware application.

Example conceptual scopes:

```text
external
host
both
```

Examples:

| Rule | Scope |
|---|---|
| HTTPS 443 inbound | both |
| HTTP 80 inbound | both |
| SSH from admin CIDR | both |
| Docker bridge isolation | host |
| loopback policy | host |
| container forwarding policy | host |

Provider firewall and local firewall should remain different adapters because they enforce policy at different layers.

---

# 13. Provider APIs vs Host Agent

Do not merge the existing VPS provider abstraction into the Host Agent abstraction.

They solve different problems.

## Provider APIs

Examples:

```text
Hostinger
Hetzner
DigitalOcean
future providers
```

Typical capabilities:

```text
external VM monitoring
external hard reboot
provider firewall
provider metadata
out-of-band actions
```

## Host Agent

Runs on the VPS itself.

Typical capabilities:

```text
local firewall
host metrics
host networking
OS information
reboot/shutdown
Docker daemon configuration
host service control
future privileged host operations
```

Conceptually:

```text
                   StackPort
                  /    |     \
                 /     |      \
                ▼      ▼       ▼
          Host Agent  VPS     Notification
                      Provider Provider
```

The Host Agent is in-band host control.

The VPS provider integration is out-of-band infrastructure control.

---

# 14. Development Strategy

During Dockerization, freeze new core functionality.

Two bounded workstreams may proceed in parallel.

```text
main
├── dockerization
└── ui-refresh
```

## 14.1 Dockerization branch

Allowed to change:

- deployment architecture;
- Docker orchestration;
- networking;
- project ports;
- nginx;
- certificate management;
- filesystem layout;
- installation;
- recovery;
- self-update;
- system/workload resource distinction;
- Compose policy;
- metrics plumbing where required by containerization;
- API/data structures when migration requires them.

Avoid unrelated feature expansion.

## 14.2 UI/UX branch

Allowed to change:

- layout;
- navigation;
- component organization;
- responsive behavior;
- accessibility;
- visual hierarchy;
- loading/error/empty states;
- current forms;
- current dashboards;
- existing workflows;
- CSS/Tailwind/SCSS/component cleanup.

Not allowed:

- new backend capabilities;
- new infrastructure concepts;
- new data sources;
- new provider integrations;
- new permissions;
- new deployment modes.

Rule:

> UI may improve how an existing capability is exposed, but it must not require a new backend capability during the Dockerization freeze.

---

# 15. Branch Integration Rule

Do not allow Dockerization and UI refresh to become permanent alternate products.

Avoid continuous cross-merging between the two feature branches.

Prefer:

```text
main
├── dockerization
├── ui-refresh
└── docker-integration
```

During development:

```text
dockerization ← main
ui-refresh    ← main
```

Near release:

```text
dockerization ──┐
                ├── docker-integration
ui-refresh ─────┘
```

Resolve integration issues there or upstream in the correct source branch.

After successful release:

```text
docker-integration → main
```

Then remove the migration branches.

Explicit rule:

> Migration branches have a defined end state and must not become long-lived competing StackPort versions.

---

# 16. Phase 1 — StackPort Core

Phase 1 delivers the Dockerized StackPort platform without requiring a Host Agent.

Phase 1 may be implemented through internal 1.x milestones, but the intended production deployment should land the StackPort + nginx + certificate-container architecture together.

The intermediate steps are implementation/testing boundaries, not permanent supported architectures.

---

# 17. Phase 1.0 — Baseline and Freeze

## Goal

Create a stable baseline before infrastructure changes begin.

## Tasks

- freeze new core features;
- disable/freeze incomplete firewall management;
- record the current supported feature set;
- define migration acceptance tests;
- document current data locations;
- document current recovery paths;
- document current nginx and certificate behavior;
- document existing project deployment behavior;
- inventory host assumptions;
- inventory all current privileged operations.

## Gate

Do not begin destructive migration work until:

- current production behavior is documented;
- existing project lifecycle tests pass;
- backup and restore of current StackPort is verified;
- a rollback path to the pre-Dockerized version exists.

---

# 18. Phase 1.1 — Containerize StackPort

## Goal

Run StackPort itself in Docker while preserving existing application behavior.

At this milestone nginx/Certbot may still be represented by compatibility/test infrastructure internally if needed, but this state is not the desired final production architecture.

## Work

- create production StackPort image;
- move build to CI;
- stop building Node/frontend dependencies on the VPS;
- define persistent data volumes/directories;
- define system stack metadata;
- provide Docker Engine access required by StackPort;
- adapt filesystem assumptions;
- adapt logging;
- adapt local metrics where necessary;
- implement container health check;
- implement container-safe restart/update primitives.

## Core security assumption

During Phase 1, StackPort may directly access:

```text
/var/run/docker.sock
```

This means compromise of StackPort should be treated as compromise of the VPS.

This is acceptable for Core because StackPort itself is the administrative control plane.

Managed workloads must never receive the Docker socket.

## Gate

- StackPort starts cleanly from an image;
- persistent state survives recreate;
- database survives recreate;
- credentials/config survive recreate;
- project lifecycle remains functional;
- no runtime npm build is required on the VPS;
- manual SSH recovery exists.

---

# 19. Phase 1.2 — System Plane / Workload Plane

## Goal

Make system resources a first-class architectural concept before nginx/certificate infrastructure becomes containerized.

## Work

- introduce authoritative system-resource tracking;
- distinguish system and project containers;
- restrict generic project APIs;
- prevent project shell access to system containers;
- prevent project deletion/volume destruction against system resources;
- introduce system-specific status/log/restart handling;
- separate system stack lifecycle from workload lifecycle.

## Gate

A generic project operation must not be able to destroy or take ownership of:

```text
StackPort
nginx
certificate service
```

---

# 20. Phase 1.3 — Compose Policy

## Goal

Prevent project-supplied Compose files from crossing the system/workload boundary.

## Work

- normalize Compose configuration before execution;
- validate dangerous host mounts;
- validate Docker socket mounts;
- validate privileged mode;
- validate host networking;
- validate host PID/IPC;
- validate capabilities/devices;
- validate network attachment;
- define policy error reporting in UI/API;
- preserve a future path for explicitly trusted workloads.

## Gate

A standard project Compose file must not be capable of acquiring host or StackPort authority through known Docker escape primitives that StackPort itself enabled.

---


# 21. Phase 1.4 — Docker Storage Management

## Goal

Make Docker/BuildKit storage pressure a first-class Core lifecycle concern so managed project builds cannot silently exhaust VPS disk space.

This capability belongs in Core because Core initiates and manages Docker builds. It does not require the Host Agent.

Dockerization removes local build cache for StackPort itself because Core should run from prebuilt images, but managed projects will continue to create image layers and BuildKit cache through normal build/deploy operations.

## Required behavior

Core must preserve the existing manual Docker build-cache prune capability and expand it into explicit storage management.

At minimum Core should expose:

```text
Docker storage
├── images
├── containers
├── volumes
└── build cache
```

The UI should distinguish between:

```text
SAFE / NORMAL
────────────────────
Build cache
Dangling images

REVIEW REQUIRED
────────────────────
Unused images
Stopped containers
Unused networks

DESTRUCTIVE
────────────────────
Volumes
```

Do not collapse these into one generic "clean Docker" action.

## Manual cleanup

The normal manual prune action should target build cache specifically.

Its expected consequence is:

```text
cache removed
    ↓
next build may be slower
```

It must not silently remove persistent project volumes.

Broader image/container cleanup should be separately reviewable and confirmation-gated.

## Automatic cache policy

Core should support a configurable safe automatic build-cache policy.

Conceptually:

```text
Build cache below target
        ↓
do nothing

Build cache / disk pressure exceeds target
        ↓
prune eligible stale cache
        ↓
recheck storage
```

Possible policy inputs include:

```text
maximum desired build-cache usage
minimum retained cache
minimum cache age before eligibility
host disk warning threshold
host disk critical threshold
```

Exact defaults are implementation decisions and should not be embedded into the architecture.

Core should perform this through Docker/BuildKit operations it already controls.

Changing host Docker daemon or BuildKit daemon configuration is not required for Core and remains a future Host Agent / Full capability.

## Pre-build disk-pressure guard

Before an operation expected to build images, Core should evaluate storage pressure.

Target flow:

```text
Deploy/build requested
        ↓
read Docker + filesystem pressure
        ↓
sufficient safe capacity?
      /        \
    yes         no
     │           │
   build    attempt safe
            cache cleanup
                 ↓
              recheck
              /    \
            yes     no
             │       │
           build    block build
```

If safe cache cleanup cannot restore enough capacity, StackPort should fail before starting the build with an actionable storage-pressure error rather than allowing Docker to exhaust the filesystem midway through a deployment.

## Storage states

Core should expose understandable storage states such as:

```text
normal
warning
critical
build-blocked
```

Thresholds should be configurable and may consider both:

```text
absolute free space
percentage free space
```

to remain useful across small and large VPS disks.

## Rollback-image protection

Core self-update introduces images that may be unused by a running container but are intentionally retained for rollback.

Storage cleanup must understand system-image retention.

At minimum protect:

```text
current Core release
previous known-good Core release
currently staged Core update
required current system-component images
required rollback system-component images when applicable
```

Example:

```text
StackPort 2.4.1   CURRENT    keep
StackPort 2.4.0   ROLLBACK   keep
StackPort 2.3.9   OLD        eligible for cleanup
```

A generic unused-image cleanup must not accidentally destroy the guaranteed rollback set.

## Volumes

Automatic maintenance must never automatically prune arbitrary Docker volumes.

Project volumes can contain production databases and other persistent application state.

Volume deletion remains an explicit destructive lifecycle operation with confirmation and project ownership/context.

## Auditing

Automatic and manual cleanup operations should be logged/audited with enough information to understand:

```text
trigger
storage before
storage after
resource category cleaned
reclaimed space
result
```

## Core vs Full boundary

```text
Capability                         Core    Full/Agent

Docker disk usage                    ✓
Build-cache usage                    ✓
Manual build-cache prune             ✓
Automatic safe cache cleanup         ✓
Pre-build disk-pressure guard        ✓
System image retention               ✓

Docker daemon GC configuration       ✕         ✓
Docker data-root configuration       ✕         ✓
Host filesystem reconfiguration      ✕         ✓
Docker daemon restart/configure      ✕         ✓
```

## Gate

Do not consider storage management complete until:

- Docker/build-cache usage is visible;
- the existing manual cache-prune capability is preserved;
- safe cache-only cleanup works;
- automatic cache cleanup can be configured;
- pre-build storage checks can block unsafe builds;
- automatic maintenance never prunes arbitrary project volumes;
- current and rollback Core images are protected;
- cleanup is auditable;
- storage pressure can be reproduced in testing and recovered without damaging project data.

Required pressure test:

```text
artificially grow BuildKit cache
        ↓
reach configured pressure threshold
        ↓
Core detects pressure
        ↓
safe cleanup runs
        ↓
project persistent data remains intact
        ↓
Core rollback image remains available
        ↓
deployment can proceed
```


# 22. Phase 1.5 — Dockerized nginx

## Goal

Move reverse-proxy ownership into the StackPort system stack.

## Work

- create/pin nginx system image;
- persist generated configuration outside ephemeral container state;
- attach nginx to StackPort control networking;
- introduce per-project edge networks;
- route by Docker DNS/service name;
- preserve config validation before activation;
- preserve backup/rollback behavior;
- replace host systemd reload with container-aware reload;
- migrate existing domain routes.

## Gate

- nginx container is the intended public HTTP/HTTPS ingress;
- configuration validation still occurs before activation;
- invalid config cannot replace the known-good route set;
- projects no longer require arbitrary host-published application ports;
- StackPort system network is isolated from workload internals.

---

# 23. Phase 1.6 — Dockerized Certificate Management

## Goal

Move certificate lifecycle into the StackPort system stack.

## Work

- introduce certificate container/service;
- persist `/etc/letsencrypt` equivalent state;
- create shared ACME challenge storage;
- configure nginx challenge route;
- implement issue;
- implement renew;
- implement delete;
- reload nginx after certificate changes;
- preserve certificate status/expiry reporting;
- support restart/recreate without certificate loss.

## Gate

A domain can complete:

```text
HTTP route
→ certificate issuance
→ HTTPS route
```

without requiring host nginx or host Certbot.

---

# 24. Phase 1.7 — Workload Networking Migration

## Goal

Move normal projects away from host-published ports.

## Work

- discover application service/internal port;
- create project edge networks;
- create project internal networks where required;
- attach nginx only where ingress is needed;
- remove/rewrite legacy published ports when safe;
- migrate health checks;
- migrate nginx routing;
- maintain compatibility logic for projects that cannot yet use the ideal network model;
- clearly identify exceptional projects.

## Gate

For standard projects:

```text
Internet → nginx → Docker network → service
```

must work without public project ports.

Only intentional public ingress should normally bind host ports.

---

# 25. Phase 1.8 — Core Self-Update

## Goal

Replace the current source-based host updater with an immutable image-based updater.

## Current model to retire

```text
git pull
npm ci
npm build
npm prune
systemctl restart stackport
```

## Target model

```text
CI
 ↓
versioned StackPort image
 ↓
registry
 ↓
StackPort updater
 ↓
pull
 ↓
backup persistent state
 ↓
recreate StackPort
 ↓
health check
 ↓
success or rollback
```

StackPort itself should not depend on surviving its own replacement.

Use an updater mechanism that remains alive while StackPort is recreated.

An ephemeral updater container is a suitable model.

Example:

```text
StackPort
   │
   └── starts update operation
             │
             ▼
     stackport-updater
             │
             ├── pull image
             ├── preserve previous version
             ├── recreate StackPort
             ├── health-check
             └── rollback on failure
```

The updater should exit after completion.

## Versioning

Prefer immutable versions:

```text
stackport:2.0.0
stackport:2.0.1
stackport:2.1.0
```

Do not make `latest` the only rollback reference.

## System stack versions

Treat nginx and certificate images as StackPort system components.

A release manifest may record:

```json
{
  "platform": "2.0.0",
  "stackport": "2.0.0",
  "nginx": "pinned-version",
  "certbot": "pinned-version"
}
```

A normal StackPort update does not need to recreate nginx/Certbot unless the desired component version changed.

## Gate

- UI-triggered Core update works;
- previous image remains available;
- failed health check rolls back;
- persistent data is not tied to image lifecycle;
- update logs are available after recovery;
- update does not require Host Agent.

---

# 26. Phase 1.9 — Core Recovery / Rollback

## Goal

Preserve an out-of-band recovery path even if StackPort cannot start.

The recovery utility must live outside the StackPort application container.

Possible UX:

```bash
sudo stackport repair
sudo stackport rollback
```

or a dedicated script under a stable host path.

Required recovery capabilities:

- verify Docker;
- inspect system stack state;
- restore/pull known-good release;
- recreate StackPort system stack;
- verify health;
- show useful logs on failure;
- rollback to previous known-good release.

## Gate

A broken StackPort container must not remove the administrator's ability to recover StackPort through SSH.

---

# 27. Phase 1.10 — Migration and Release Candidate

## Goal

Prove that existing installations can migrate safely.

## Migration must cover

- SQLite/database;
- credentials;
- project records;
- project repositories/files;
- project env files;
- domain configuration;
- nginx templates/custom directives;
- certificates;
- logs/audit data as required;
- health-check configuration;
- GitHub poller configuration;
- notification configuration;
- Docker project state where practical.

## Required test cases

- fresh Core install;
- current install → Core migration;
- Core restart;
- Docker daemon restart;
- VPS reboot;
- Core self-update;
- Core rollback;
- nginx invalid-config rollback;
- certificate issue;
- certificate renewal;
- project deploy;
- project rebuild;
- project force recreate;
- project logs;
- project shell;
- project health check;
- auto-deploy;
- uploaded project;
- GitHub project;
- project deletion;
- destructive volume operation restricted correctly;
- system-resource protection;
- workload policy rejection.

## Release gate

Phase 1 is complete only when Core can replace the current native StackPort installation without requiring the Host Agent.

---

# 28. Phase 1 Final State — StackPort Core

The intended Core architecture is:

```text
Host OS
│
├── Docker Engine
│
└── Docker
    │
    ├── StackPort
    ├── nginx
    ├── certificate manager
    │
    ├── Project A
    ├── Project B
    └── ...
```

Core does not require a Host Agent.

Core remains useful and complete for Docker-level management.

The host still owns Docker itself and operating-system functions that StackPort Core intentionally does not manage.

---

# 29. Phase 2 — StackPort Full

Phase 2 introduces the optional StackPort Host Agent.

Installing the Agent turns the same StackPort installation into the product-facing "StackPort Full" state.

No separate StackPort build or database migration should be required merely to switch:

```text
Core → Full
```

Likewise removing/disabling the Agent should degrade:

```text
Full → Core
```

without damaging projects or system-stack state.

---

# 30. Host Agent Responsibilities

Initial Agent responsibilities should focus only on capabilities that genuinely require host authority.

Initial likely scope:

```text
local firewall
authoritative host metrics
host network information/configuration
reboot/shutdown
OS information
Docker daemon configuration if required
selected host service/system operations
```

Do not put nginx or certificate operations back into the Agent.

Those belong to Core after Phase 1.

---

# 31. Agent Communication

Prefer a local Unix socket for the same-host case.

Example:

```text
/run/stackport/agent.sock
```

Conceptually:

```text
StackPort container
       │
       ▼
Host Agent socket
       │
       ▼
stackport-agent
       │
       ▼
Host OS
```

The Agent should expose a narrow capability API rather than arbitrary host command execution.

---

# 32. Capability Discovery

Do not hard-code behavior around an `edition === "full"` conditional.

StackPort should discover Agent capabilities.

Example conceptual response:

```json
{
  "agentVersion": "1.0.0",
  "protocolVersion": 1,
  "capabilities": {
    "firewall": true,
    "hostMetrics": true,
    "reboot": true,
    "shutdown": true,
    "networkManagement": false
  }
}
```

This supports:

```text
Core
Full
Full with a capability disabled
restricted Agent
future Agent versions
future remote Agent use
```

---

# 33. Full Failure Model

Agent failure must not make Core unusable.

If the Agent disconnects:

```text
Projects             available
Deployments          available
nginx                available
Certificates         available
Docker management    available
Logs                 available
Project shells       available

Host firewall        unavailable
Host metrics         unavailable or degraded
Host reboot          unavailable
Host OS operations   unavailable
```

UI should clearly indicate Agent state without treating StackPort itself as failed.

---

# 34. Full Firewall Implementation

Firewall implementation begins only after Phase 1 networking is stable.

The Agent should own local firewall application.

Provider firewall integration remains a separate provider abstraction.

The long-term desired policy model is:

```text
                 StackPort desired policy
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      Provider firewall        Host Agent
                               local firewall
```

Docker networking remains a third enforcement layer but should be generated as part of workload/network policy rather than represented as the same firewall backend.

---

# 35. Core Self-Update vs Agent Self-Update

This distinction is important.

Post-Dockerization there are two different update systems.

## StackPort Core update

Container/image based:

```text
Registry
   ↓
versioned image
   ↓
ephemeral updater
   ↓
recreate StackPort
   ↓
health check
   ↓
rollback image if required
```

Works in both Core and Full.

Does not require the Host Agent.

## Host Agent update

Host-native binary update:

```text
StackPort
   ↓
Agent API
   ↓
stage new Agent binary
   ↓
detached/system update operation
   ↓
restart Agent
   ↓
health check
   ↓
rollback binary if required
```

The Agent update mechanism is conceptually similar to the current native StackPort self-update because the Agent remains a host-native service.

However, it is not the same updater as Core.

---

# 36. Agent Release Layout

Prefer versioned Agent installations.

Example:

```text
/opt/stackport-agent/
├── releases/
│   ├── 1.0.0/
│   │   └── stackport-agent
│   └── 1.1.0/
│       └── stackport-agent
│
└── current -> releases/1.1.0/
```

systemd runs:

```text
/opt/stackport-agent/current/stackport-agent
```

Upgrade:

```text
current → 1.0.0
        ↓
stage 1.1.0
        ↓
current → 1.1.0
        ↓
restart
        ↓
health check
```

Failure:

```text
current → 1.0.0
restart
```

Do not overwrite the currently running binary in place as the primary update strategy.

---

# 37. Agent Update Orchestration

The Agent should not be responsible for remaining alive while directly replacing itself.

Use an update operation that survives Agent shutdown.

Possible implementation:

```text
stackport-agent-update.service
```

Sequence:

```text
Agent receives signed/authorized update request
        ↓
download release
        ↓
verify checksum/signature
        ↓
stage release
        ↓
start detached updater/systemd update unit
        ↓
Agent exits/stops
        ↓
switch current version
        ↓
start Agent
        ↓
health check
        ↓
rollback if unhealthy
```

---

# 38. Version Independence

Do not couple StackPort and Agent versions 1:1.

Avoid requiring:

```text
StackPort 2.4.3
Agent     2.4.3
```

Prefer:

```text
StackPort Core: 2.4.3
Agent:          1.7.1
Protocol:       v1
```

StackPort and Agent should negotiate:

- Agent version;
- protocol version;
- supported capabilities.

Each should be independently updatable while maintaining a defined compatibility window.

---

# 39. Protocol Compatibility

Use protocol versioning rather than binary-version equality.

Example transition:

```text
StackPort version N
supports Agent protocols 1 and 2

Agent v2
uses protocol 2
```

Migration:

```text
upgrade StackPort to dual-protocol support
        ↓
upgrade Agent
        ↓
verify fleet/state
        ↓
future StackPort may remove old protocol
```

Do not design updates that require Core and Agent to update at exactly the same moment.

---

# 40. Full "Update All"

StackPort Full may eventually expose:

```text
Settings → Updates

StackPort
current → available

Host Agent
current → available

System components
current → desired
```

A future `Update All` should be orchestrated rather than simultaneous.

Preferred order:

```text
1. verify backup/recovery prerequisites
2. update Agent if required
3. verify Agent health
4. update Core
5. verify Core health
6. update system components if required
7. run final overall health check
```

This ordering assumes the new Agent remains compatible with the currently running Core.

If Agent update fails:

```text
stop
do not update Core
```

Core remains operational.

---

# 41. Custom States

Runtime state should be capability-based.

Examples:

## Core

```text
Agent: absent

Docker features: available
Host-level features: unavailable
```

## Full

```text
Agent: connected
Firewall: available
Host metrics: available
Reboot: available
```

## Full / Restricted

```text
Agent: connected
Firewall: disabled
Host metrics: available
Reboot: unavailable
```

## Full / Degraded

```text
Agent: expected but disconnected

Core features: available
Agent features: unavailable
```

The product should tolerate these states deliberately rather than treating them as exceptional implementation accidents.

---

# 42. Installation Model

## Core

Conceptual install:

```text
install Docker if needed
create StackPort persistent directories/volumes
create system network
install system Compose definition
start StackPort
start nginx
start certificate service
verify health
```

Host prerequisites should eventually be kept as small as practical.

## Full

Full installation adds:

```text
install stackport-agent
create Agent configuration
create Unix socket permissions
install systemd unit
enable/start Agent
verify StackPort ↔ Agent connection
```

Core remains unchanged.

---

# 43. Agent Removal

Agent installation must be reversible.

Removing the Agent must not remove:

- StackPort;
- projects;
- Docker networks;
- nginx;
- certificates;
- database;
- project data;
- StackPort configuration.

Semantically:

```text
Full → Core
```

rather than:

```text
Full → broken StackPort
```

---

# 44. Docker Socket Future

Phase 1 Core may give StackPort direct Docker socket access.

This is acceptable as an intentional initial control-plane privilege.

After the Host Agent exists, a future hardening phase may optionally move privileged Docker operations behind the Agent.

Current Core:

```text
StackPort → docker.sock
```

Possible future:

```text
StackPort
   ↓
Agent API
   ↓
docker.sock
```

This is not required for Phase 1 or initial Phase 2.

Do not make it a prerequisite for Dockerization.

---

# 45. Scope Freeze During Phase 1

Do not add unrelated infrastructure features while Dockerization is active.

Examples of work to defer:

- new VPS providers;
- new firewall capabilities;
- new deployment paradigms;
- new project source types;
- new permissions architecture;
- new host-management features;
- unrelated metric sources;
- major new automation systems.

Allowed exceptions:

- changes required to preserve existing behavior;
- changes required by Dockerization;
- security fixes;
- critical production bugs;
- UI/UX work that does not expand backend scope.

---

# 46. Core Release Acceptance Checklist

Phase 1 should not be considered complete until all applicable items pass.

## Installation

- [ ] Fresh Core installation succeeds.
- [ ] No Host Agent is required.
- [ ] StackPort starts from a versioned image.
- [ ] nginx starts as a system container.
- [ ] certificate management starts as a system container/service.
- [ ] persistent data paths are explicit.
- [ ] reboot recovery is verified.

## Migration

- [ ] Existing StackPort installation can migrate.
- [ ] SQLite data survives.
- [ ] credentials survive.
- [ ] projects survive.
- [ ] env files survive.
- [ ] domains survive.
- [ ] certificates survive.
- [ ] nginx custom configuration survives where supported.
- [ ] health checks survive.
- [ ] poller configuration survives.
- [ ] notification configuration survives.

## Workload security

- [ ] System resources are authoritative and protected.
- [ ] Project APIs cannot delete system resources.
- [ ] Project shells cannot target system resources.
- [ ] Docker socket mounts are blocked for normal workloads.
- [ ] privileged mode is blocked by default.
- [ ] host networking is blocked by default.
- [ ] sensitive host mounts are blocked.
- [ ] system network attachment is blocked.

## Docker storage

- [ ] Docker disk usage is visible.
- [ ] Build-cache usage and reclaimable space are visible.
- [ ] Existing manual build-cache prune remains available.
- [ ] Manual cache cleanup does not prune project volumes.
- [ ] Automatic safe build-cache cleanup can be configured.
- [ ] Pre-build disk-pressure checks run before image-building operations.
- [ ] Unsafe builds are blocked when safe cleanup cannot recover enough capacity.
- [ ] Warning/critical/build-blocked storage states are understandable.
- [ ] Current Core image is protected from cleanup.
- [ ] Previous known-good rollback image is protected from cleanup.
- [ ] Staged update images are protected while an update is in progress.
- [ ] Automatic maintenance never prunes arbitrary Docker volumes.
- [ ] Cleanup actions are audited/logged.
- [ ] Artificial BuildKit-cache pressure can be recovered without project-data loss.

## Networking

- [ ] nginx is the normal public ingress.
- [ ] project edge networks are isolated.
- [ ] project-to-project access is denied by default.
- [ ] project-to-control-plane access is denied by default.
- [ ] normal project applications do not require public host ports.
- [ ] HTTP works.
- [ ] HTTPS works.

## Certificates

- [ ] Issue works.
- [ ] Renew works.
- [ ] Delete works.
- [ ] Certificate data survives recreate.
- [ ] nginx reload after certificate change works.
- [ ] ACME challenge works after reboot.

## nginx

- [ ] Generated configuration is validated.
- [ ] Failed validation does not replace live configuration.
- [ ] Backup/rollback works.
- [ ] Reload is container-aware.
- [ ] Existing project custom config behavior is preserved or explicitly migrated.

## Project lifecycle

- [ ] GitHub project create works.
- [ ] Uploaded project create works.
- [ ] Pull works.
- [ ] Build works.
- [ ] Deploy works.
- [ ] Force recreate works.
- [ ] Force rebuild works.
- [ ] Stop works.
- [ ] Delete works.
- [ ] Destructive volume delete remains confirmation-gated.
- [ ] Pause/resume routing works.
- [ ] Env files work.
- [ ] Multiple Compose files work.
- [ ] Missing active Compose file remains a safe failure.
- [ ] Logs work.
- [ ] Interactive project shell works.
- [ ] Health checks work.
- [ ] Auto-deploy works.

## Core self-update

- [ ] Update check works.
- [ ] Versioned image pull works.
- [ ] StackPort can replace itself.
- [ ] Updater survives StackPort replacement.
- [ ] Health validation occurs.
- [ ] Failed update rolls back.
- [ ] Previous version remains recoverable.
- [ ] Update logs survive failure.
- [ ] No Agent is required.

## Recovery

- [ ] SSH recovery path exists.
- [ ] Broken StackPort image can be rolled back.
- [ ] Recovery works when UI is unavailable.
- [ ] Recovery does not require a working StackPort process.
- [ ] Recovery instructions are documented.

---

# 47. Full Release Acceptance Checklist

Phase 2 should not be considered complete until all applicable items pass.

## Agent

- [ ] Agent installation succeeds independently of Core.
- [ ] Agent uses a narrow local API.
- [ ] Unix-socket permissions are correct.
- [ ] Capability discovery works.
- [ ] Agent disconnect does not break Core.
- [ ] Agent reconnect is automatic or clearly recoverable.
- [ ] Agent removal returns StackPort to Core state.

## Host metrics

- [ ] Host CPU is authoritative.
- [ ] Host memory is authoritative.
- [ ] Host filesystem data is authoritative.
- [ ] Host networking information is correct.
- [ ] Container metrics remain distinct from host metrics.

## Firewall

- [ ] Local firewall policy is Agent-managed.
- [ ] Provider firewall remains a separate adapter.
- [ ] Policy scope is explicit.
- [ ] Docker networking is not confused with provider/local firewall policy.
- [ ] Effective inbound policy is understandable.
- [ ] StackPort cannot accidentally lock out recovery without safeguards.
- [ ] Firewall rollback/recovery exists.

## Host operations

- [ ] Reboot works safely.
- [ ] Shutdown behavior is explicit.
- [ ] OS operations are narrowly authorized.
- [ ] Arbitrary shell execution is not the Agent API design.

## Agent self-update

- [ ] Agent release can be staged.
- [ ] Artifact integrity is verified.
- [ ] Update operation survives Agent stop.
- [ ] Version switch is atomic.
- [ ] New Agent health is verified.
- [ ] Failed Agent update rolls back.
- [ ] Core remains usable during Agent failure.
- [ ] Agent and Core versions are independently tracked.
- [ ] Protocol compatibility is validated.

---

# 48. Sanity Checks

When implementation decisions become unclear, ask these questions.

## Boundary

- Is this capability Docker-level or host-OS-level?
- Does this belong in Core or behind the Agent?
- Are we accidentally giving a workload control-plane authority?
- Can a project-supplied Compose file escape the intended workload boundary?

## Networking

- Why is this port published to the host?
- Could nginx reach this service through a Docker network instead?
- Is this project attached to a network containing unrelated projects?
- Can this workload reach StackPort itself?

## System resources

- Could a generic project action target this container?
- Could project cleanup delete this volume/network?
- Is system state being identified only through mutable Docker labels?

## Storage

- Is this cleanup targeting build cache, images, containers, or persistent volumes?
- Could this cleanup remove the current or previous known-good Core release?
- Could an automatic action touch project database/storage volumes?
- Do we know storage pressure before starting a build?
- If safe cleanup cannot free enough space, do we fail before Docker fills the filesystem?
- Is the cleanup result visible and auditable?

## Updates

- What happens if the component being updated dies halfway through?
- Does the updater survive the process it replaces?
- Is the previous version still available?
- Does persistent state survive rollback?
- Can recovery happen without the UI?

## Agent

- Does this operation genuinely require host authority?
- Are we putting Docker/nginx/certificate behavior into the Agent unnecessarily?
- Does Core continue working if the Agent disappears?
- Are Core and Agent versions unnecessarily coupled?

## Scope

- Is this required for Dockerization?
- Is this an existing behavior being preserved?
- Is this a security fix?
- If not, should it wait until after the Core release?

---

# 49. Explicit Non-Goals for Phase 1

Phase 1 is not intended to deliver:

- local firewall management;
- a Host Agent;
- generalized host OS management;
- new provider integrations;
- remote multi-host Agent management;
- complete removal of direct Docker socket access from StackPort;
- arbitrary project privilege models;
- unrelated new product features.

These may be future work.

---

# 50. Explicit Non-Goals for Initial Phase 2

Initial Full should not automatically expand into:

- a remote orchestration platform;
- a general-purpose root command daemon;
- cluster management;
- Kubernetes;
- distributed scheduling;
- broad package management;
- provider API replacement.

The first Agent exists to restore intentional host-level capabilities that cannot cleanly live inside Core.

---

# 51. Long-Term Direction

The architecture should leave room for, but not require, a future model such as:

```text
                   StackPort
                       │
             ┌─────────┼─────────┐
             ▼         ▼         ▼
          Agent A   Agent B   Agent C
             │         │         │
           VPS A     VPS B     VPS C
```

Likewise, Docker operations may later move behind the Agent if the additional security boundary is worth the implementation cost.

Neither direction is a Phase 1 requirement.

---

# 52. Final Target Summary

## Phase 1 — StackPort Core

```text
Host
└── Docker
    ├── StackPort
    ├── nginx
    ├── certificate manager
    └── isolated project workloads
```

Characteristics:

- no Host Agent required;
- Docker is the primary execution boundary;
- nginx and TLS are StackPort-owned containers;
- project ports move behind Docker networking;
- Docker/build-cache storage pressure is actively managed by Core;
- pre-build disk guards prevent uncontrolled cache growth from exhausting the VPS;
- system/workload distinction is enforced;
- workload Compose definitions are policy-validated;
- StackPort updates through versioned container images;
- failed Core updates roll back;
- SSH recovery remains available;
- firewall control is intentionally deferred.

## Phase 2 — StackPort Full

```text
Host
├── stackport-agent
│   ├── firewall
│   ├── host metrics
│   ├── host networking
│   └── privileged host operations
│
└── Docker
    ├── StackPort Core
    ├── nginx
    ├── certificate manager
    └── isolated project workloads
```

Characteristics:

- same StackPort product/codebase as Core;
- Agent is optional;
- capabilities are discovered dynamically;
- Agent failure degrades Full to Core behavior;
- Agent uses its own host-native update lifecycle;
- Core keeps its independent image-based update lifecycle;
- provider APIs remain separate out-of-band integrations;
- local/provider firewall can later share one desired policy without becoming the same backend.

---

# 53. Governing Rule

The migration is successful when StackPort becomes easier to deploy and recover **without making the control boundary harder to understand**.

The architecture should always make these three facts obvious:

```text
1. StackPort intentionally controls Docker.

2. Managed workloads do not control StackPort.

3. Host-OS control exists only where explicitly required,
   and after Phase 1 that boundary is the optional Host Agent.
```
