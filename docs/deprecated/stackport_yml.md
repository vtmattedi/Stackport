# StackPort YAML / Compose Architecture

## Status

**Planned for:** StackPort migration from the current systemd-based deployment to a Dockerized StackPort architecture.

This document defines how StackPort will handle user-provided Docker Compose YAML after the migration.

The main goal is to remove the current ambiguity between:

- ports defined by StackPort;
- ports defined by Compose YAML;
- ports written into Nginx configuration;
- dynamically allocated host ports.

The Dockerized architecture must establish a single source of truth for routing and prevent managed applications from exposing arbitrary host ports.

---

# 1. Core Invariants

The Docker migration must enforce the following rules.

1. **StackPort-managed applications must never publish host ports.**
2. `network_mode: host` is forbidden.
3. StackPort owns all public network exposure.
4. Compose YAML describes application topology, not VPS exposure.
5. HTTP/HTTPS/WebSocket routing is represented as:

   ```text
   domain -> service -> container port
   ```

6. Nginx routes directly to Docker service/container addresses over a StackPort-managed proxy network.
7. Nginx must not depend on random host-port allocation.
8. The user's source YAML is immutable input.
9. StackPort must never silently rewrite conflicting user configuration.
10. Invalid or policy-incompatible YAML is rejected.
11. Every deployment operates against an immutable source revision.
12. Failed candidate revisions must never replace the last-known-good deployment.
13. Nginx and Docker configuration must derive from the same normalized StackPort deployment model.
14. Runtime infrastructure must only be mutated after the full candidate deployment has passed validation.

---

# 2. Remove Dual Port Ownership

The current architecture can produce conflicting sources of truth:

```text
docker-compose.yml
        +
StackPort project configuration
        +
Nginx configuration
        ↓
port mismatch / collision
```

This has produced classes of failures such as:

- incorrect ports written into Nginx;
- Compose failing because a host port is already in use;
- StackPort expecting a different port from the one declared in YAML;
- externally reachable ports that StackPort did not intend to expose.

After Dockerization, this model must be removed.

## New ownership rule

> StackPort owns external exposure. Compose owns only container-internal application topology.

A managed project must therefore not contain:

```yaml
services:
  app:
    ports:
      - "5000:3000"
```

It must also not contain:

```yaml
services:
  app:
    network_mode: host
```

Instead, services listen normally inside their containers:

```yaml
services:
  app:
    expose:
      - "3000"
```

`expose` may be accepted, but StackPort must not depend on it as the source of routing truth.

The authoritative route is stored by StackPort:

```text
domain: app.example.com
service: app
container_port: 3000
```

Nginx then routes directly to:

```nginx
proxy_pass http://app:3000;
```

No host port is required.

---

# 3. Normalized Deployment Model

StackPort should parse user YAML into a normalized internal deployment model before generating any runtime configuration.

Example conceptual model:

```ts
type ServiceEndpoint = {
  service: string;
  containerPort: number;
};

type PublicRoute = {
  domain: string;
  endpoint: ServiceEndpoint;
};
```

Example:

```json
{
  "domain": "app.example.com",
  "endpoint": {
    "service": "frontend",
    "containerPort": 3000,
  }
}
```

This normalized object becomes the source of truth for:

- proxy routing;
- Docker network attachment;
- deployment validation;
- health checks;
- UI display;
- deployment status;
- generated Nginx configuration.

There must not be independent port calculations for Compose and Nginx.

---

# 4. Three Configuration Layers

StackPort should distinguish between three representations.

## 4.1 Source

The exact Compose YAML received from the repository.

```text
SOURCE
```

Properties:

- immutable;
- tied to an exact Git commit/revision;
- never edited by StackPort;
- retained for audit/debugging.

## 4.2 Desired / Deployment Plan

The parsed and validated StackPort representation.

Example:

```text
revision: abc123
domain: app.example.com
service: frontend
container_port: 3000
```

This represents what StackPort intends to deploy.

## 4.3 Effective Compose

The actual Compose configuration used by Docker after StackPort applies infrastructure it owns.

For example, StackPort may add:

- `stackport-proxy` network membership;
- StackPort-generated labels;
- controlled metadata;
- generated network declarations.

Conceptually:

```text
source-compose.yml
        +
StackPort deployment configuration
        ↓
effective-compose.yml
        ↓
Docker
```

Nginx should be generated from the **Deployment Plan**, not by independently parsing the effective or source YAML.

---

# 5. Source YAML Must Not Be Mutated

StackPort must never modify the repository YAML in place.

The source file is user-owned input.

For example, if the source contains:

```yaml
services:
  app:
    ports:
      - "3000:3000"
```

StackPort must **not** silently transform it into:

```yaml
services:
  app:
    # ports removed by StackPort
```

Instead, the deployment must fail with an actionable error:

```text
Deployment rejected.

services.app.ports:
Host port publication is not allowed for StackPort-managed services.

Configure the service as a StackPort route using its internal container port.
```

General rule:

> StackPort may add configuration that StackPort owns. It must not silently remove or reinterpret configuration explicitly requested by the user.

---

Adtionally: Fixable error can be fixed by stackport ON USER ACTION:

1. modify failing yml.
2. git add failing yml.
3. git commit -m <[STACKPORT] fixing error {error.name} in {file.name}>
4. git push.
5. if we fail revert. 

then sendback feedback to the user.

# 6. Validation Policy

Validation must happen before any runtime infrastructure is changed.

Recommended pipeline:

```text
receive revision
      ↓
snapshot exact source
      ↓
parse YAML
      ↓
validate Compose structure
      ↓
validate StackPort policy
      ↓
normalize deployment model
      ↓
generate effective Compose
      ↓
docker compose config
      ↓
build deployment plan
      ↓
deploy
```

## 6.1 YAML parsing

Malformed YAML is rejected.

StackPort must not attempt to repair syntax errors automatically.

## 6.2 Compose validation

The Compose structure must be valid.

A candidate should pass a validation equivalent to:

```bash
docker compose -f effective-compose.yml config
```

before deployment.

## 6.3 StackPort policy validation

At minimum, reject:

```yaml
ports:
```

for managed application services.

Reject:

```yaml
network_mode: host
```

Additional security-sensitive settings should be reviewed and either forbidden or explicitly governed by policy, including:

```yaml
privileged: true
```

```yaml
pid: host
```

```yaml
ipc: host
```

and dangerous host mounts such as:

```yaml
volumes:
  - /:/host
```

or:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

The exact policy for these fields should be finalized as part of Docker hardening.

---

# 7. Internal Ports

Container-internal ports are allowed.

For example:

```yaml
services:
  frontend:
    expose:
      - "3000"

  api:
    expose:
      - "8080"

  redis:
    expose:
      - "6379"
```

However, StackPort must not infer public routing from `expose`.

Explicit StackPort routing configuration determines what is public:

```text
app.example.com
    -> frontend:3000

api.example.com
    -> api:8080
```

Redis remains private:

```text
redis:6379
```

A service being reachable on a Docker network does not imply it is publicly exposed.

---

# 8. Docker Networks

Each project should retain its own private Compose network.

Example:

```text
project_a_default
├── frontend
├── api
├── postgres
└── redis
```

Only services that StackPort needs to proxy should additionally join the shared external proxy network:

```text
stackport-proxy
├── stackport-proxy/nginx
├── project-a-frontend
├── project-a-api
└── project-b-web
```

Infrastructure such as databases, Redis, workers, and other private services should not join `stackport-proxy` unless explicitly required.

Example StackPort augmentation:

```yaml
services:
  frontend:
    networks:
      - default
      - stackport-proxy

networks:
  stackport-proxy:
    external: true
```

This augmentation is StackPort-owned configuration and is therefore valid to generate in the effective Compose representation.

---

# 9. Eliminate Host-Port Allocation

Managed web applications should no longer require random host port allocation.

Old model:

```text
project
  ↓
find free host port
  ↓
5995:3000
  ↓
Nginx -> 127.0.0.1:5995
```

New model:

```text
domain
  ↓
Docker service
  ↓
container port
```

Example:

```text
project-a-web:3000
project-b-web:3000
project-c-web:3000
```

All three can use the same internal port without collision because each container has its own network namespace.

This removes the current class of `port already in use` errors caused by host-port mappings.

---

# 10. Deployment Snapshots

StackPort should save a snapshot for every deployment candidate.

Snapshots should be associated with a deployment/revision ID rather than continuously overwriting a single project YAML.

Example:

```text
projects/
└── <project-id>/
    └── revisions/
        ├── <revision-a>/
        │   ├── source-compose.yml
        │   ├── effective-compose.yml
        │   └── metadata.json
        │
        ├── <revision-b>/
        │   ├── source-compose.yml
        │   ├── effective-compose.yml
        │   └── metadata.json
        │
        └── ...
```

Metadata should include enough information to reproduce and diagnose the deployment.

Example:

```json
{
  "commit": "9bd8f7...",
  "branch": "main",
  "sourceHash": "sha256:...",
  "receivedAt": "2026-08-15T00:00:00Z",
  "trigger": "webhook"
}
```

Useful additional fields may include:

- deployment ID;
- project ID;
- StackPort version;
- Compose validation result;
- deployment status;
- previous successful revision;
- start/end timestamps.

---

# 11. Immutable Git Revision

Webhook and poller-driven deployments must never operate against a moving branch head.

Bad:

```text
webhook for commit A
      ↓
deployment reads main/docker-compose.yml
      ↓
commit B lands during deployment
      ↓
deployment accidentally consumes B
```

Required:

```text
webhook for commit A
      ↓
resolve exact SHA A
      ↓
fetch/checkout SHA A
      ↓
snapshot source YAML
      ↓
all deployment work uses snapshot A
```

Invariant:

> A deployment always operates against one immutable source revision.

If commit B arrives while A is deploying, B becomes a separate candidate deployment.

---

# 12. Last-Known-Good Deployment

Each project must distinguish between:

```text
desired/latest revision
last attempted revision
active revision
```

Example:

```text
Commit A
Compose valid
Deployment succeeds
→ ACTIVE = A

Commit B
Compose invalid
Deployment rejected
→ ACTIVE remains A
```

A broken repository update must not destroy the working deployment.

The UI should be able to represent this state clearly:

```text
Current deployment:
a941bc7 ✓

Latest repository revision:
f1279ad ✗ rejected

Reason:
services.api.ports is forbidden.
```

---

# 13. Invalid YAML Behavior

There are two important failure categories.

## 13.1 Invalid YAML / invalid Compose

Examples:

- YAML syntax failure;
- invalid Compose shape;
- unsupported malformed service configuration;
- `docker compose config` failure.

Behavior:

```text
candidate revision = rejected
active revision = unchanged
```

Do not attempt automatic repair.

## 13.2 Valid Compose that violates StackPort policy

Examples:

```yaml
ports:
```

```yaml
network_mode: host
```

or another forbidden security-sensitive field.

Behavior is also rejection.

StackPort should provide a precise error showing:

- offending service;
- offending field;
- reason;
- expected StackPort-compatible alternative.

---

# 14. StackPort-Owned Augmentation

StackPort may generate configuration for infrastructure it owns.

Examples:

- attach selected services to `stackport-proxy`;
- add controlled labels;
- add StackPort metadata;
- generate effective Compose;
- generate Nginx routes.

This is different from repairing or rewriting user intent.

Rule:

> StackPort may add what StackPort owns. Explicit user configuration that conflicts with StackPort policy must be rejected.

---

# 15. Transactional Deployment Ordering

StackPort should stop modifying Nginx before knowing whether the workload is deployable.

Bad flow:

```text
parse YAML
      ↓
write Nginx
      ↓
docker compose up
      ↓
Compose fails
      ↓
Nginx points to nonexistent workload
```

Target flow:

```text
1. Resolve immutable source revision
2. Snapshot source YAML
3. Parse YAML
4. Validate Compose structure
5. Validate StackPort policy
6. Normalize deployment model
7. Generate effective Compose
8. Run docker compose config
9. Prepare deployment
10. Start/update workload
11. Verify target service is reachable internally
12. Generate Nginx configuration
13. Run nginx -t
14. Activate/reload Nginx
15. Mark revision active
```

If any pre-activation step fails:

```text
candidate = failed
current active deployment = unchanged where possible
```

Runtime mutation should occur only after the candidate is known to be viable.

---

# 16. Nginx Generation

Nginx must use the normalized StackPort deployment model.

Example deployment plan:

```json
{
  "projectId": "abc",
  "domain": "foo.example.com",
  "service": "web",
  "port": 3000,
  "protocol": "http"
}
```

Generated routing:

```nginx
location / {
    proxy_pass http://web:3000;

    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

WebSocket-capable routes should include the required upgrade behavior.

There must no longer be an independent Nginx-side port lookup or host-port allocation step.

---

# 17. Rollback

Snapshots should make project rollback deterministic.

A previous successful deployment should retain:

```text
source-compose.yml
effective-compose.yml
deployment plan
revision metadata
```

Rollback should use the previous known-good deployment artifacts rather than re-reading the current repository branch.

Conceptually:

```text
previous successful revision
        ↓
stored deployment plan
        +
stored effective Compose
        ↓
redeploy
```

This ensures rollback means "restore what was actually running", not "try to reconstruct an old state from current configuration."

---

# 18. Retention

StackPort does not necessarily need to retain every historical deployment forever because Git already retains source history.

A reasonable retention policy may keep:

- current active deployment;
- previous successful deployment;
- recent failed deployments;
- last N deployment snapshots.

For example:

```text
last 10-20 deployment revisions
+
active revision regardless of age
+
previous successful revision regardless of age
```

Retention policy can be made configurable later.

---

# 19. MQTT and Non-HTTP Exposure

The no-host-port rule applies to normal managed applications.

Public non-HTTP protocols such as MQTTS are infrastructure exposure decisions owned by StackPort.

A managed Mosquitto container should not independently publish:

```yaml
ports:
  - "8883:8883"
```

Instead, StackPort infrastructure owns whether a public listener such as `8883/tcp` exists.

This preserves the invariant:

> Applications do not decide what the VPS exposes. StackPort decides what the VPS exposes.

The detailed implementation of TCP/MQTTS routing can be finalized separately during Docker networking work.

---

# 20. Host Firewall Relationship

The Dockerized StackPort target host is expected to expose only intentionally supported infrastructure ports, currently:

```text
22/tcp    SSH
80/tcp    HTTP
443/tcp   HTTPS
8883/tcp  MQTTS
```

Managed applications must not be able to create additional public host listeners.

The firewall remains defense-in-depth, while StackPort YAML validation prevents managed workloads from requesting arbitrary host exposure in the first place.

---

# 21. Migration Goals

The systemd-to-Docker migration should use this YAML redesign to eliminate the current mixed routing model.

The migration is considered successful when:

- StackPort itself is Dockerized;
- managed applications no longer require dynamically allocated host ports;
- managed Compose files cannot publish host ports;
- public web routes use Docker service names and container ports;
- Nginx and Docker configuration come from one normalized deployment plan;
- source and effective YAML snapshots are retained per deployment;
- webhook/poller deployments use immutable Git revisions;
- invalid candidates do not replace the active deployment;
- rollback uses stored known-good deployment artifacts;
- policy violations fail closed with actionable errors.

---

# 22. Summary

The Dockerized StackPort model should be:

```text
Git revision
     ↓
immutable source-compose.yml
     ↓
parse + validate
     ↓
StackPort Deployment Plan
     ↓
effective-compose.yml
     ↓
Docker private/project networks
     ↓
selected service joins stackport-proxy
     ↓
Nginx generated from same Deployment Plan
     ↓
public HTTP/HTTPS/WS route
```

The central architectural rule is:

> **Compose describes the application. StackPort controls exposure.**

This removes dual port ownership, prevents host-port collisions, makes routing deterministic, improves rollback/reproducibility, and creates a clear security boundary for StackPort-managed workloads.
