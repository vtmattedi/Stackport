# StackPort Host Lifecycle and Bootstrap Design

## Purpose

This document defines the host-side lifecycle model for StackPort once installation and management are consolidated under a single command:

```bash
stackport <command>
```

The downloadable bootstrap artifact may initially be named:

```bash
stackport.sh
```

After installation, it should install the management command globally, for example:

```text
/usr/local/bin/stackport
```

The host-side tool is responsible for StackPort itself and its supporting infrastructure. It is **not** the project deployment CLI.

Managed application deployment, redeployment, rebuild, rollback, logs, and runtime actions remain inside StackPort.

---

# 1. Core Design Principles

## 1.1 One lifecycle command

Use one host-management entry point:

```bash
stackport install
stackport update
stackport rollback
stackport status
stackport repair
stackport admin-recovery
stackport uninstall
stackport uninstall --purge
```

The implementation may begin as:

```bash
sudo ./stackport.sh install
```

and then install itself or a canonical version as:

```bash
/usr/local/bin/stackport
```

Thereafter:

```bash
sudo stackport update
```

is the normal operator interface.

---

## 1.2 Explicit commands, never inferred destructive behavior

Running the tool without a command must not guess whether the user wants to install, repair, or uninstall.

Example:

```bash
stackport
```

should print usage.

It must **never** behave like:

```text
"StackPort already exists. Do you want to uninstall it?"
```

Installation, recovery, rollback, and destruction must always be explicit.

---

## 1.3 Idempotency

Every non-destructive lifecycle operation should be safe to rerun.

For example:

```bash
stackport install
```

on an existing installation should preserve:

- persistent database/state
- machine secrets
- TLS certificates
- configured domain
- existing administrators
- project state
- backups

It may safely restore or verify missing infrastructure.

It must not:

- regenerate JWT secrets
- recreate a bootstrap admin
- reset passwords
- wipe databases
- request unnecessary certificates
- overwrite persistent configuration blindly

---

# 2. Target Host Architecture

After Dockerization, the target host should contain only minimal host dependencies.

```text
Ubuntu Server 24.04 LTS
│
├── Docker Engine
├── firewall
├── SSH
├── /usr/local/bin/stackport
│
├── /etc/stackport/
│   ├── stackport.env
│   ├── secrets.env
│   └── install.conf
│
├── /var/lib/stackport/
│   ├── data/
│   ├── backups/
│   ├── compose/
│   ├── nginx/
│   ├── letsencrypt/
│   ├── certbot/
│   └── update/
│
└── Docker
    ├── stackport
    ├── stackport-proxy
    ├── stackport-certbot
    └── managed projects
```

The final target should not require host-installed Nginx or Certbot.

---

# 3. Installation Questions

The installer should ask only for values that genuinely vary between installations.

Recommended interactive inputs:

```text
StackPort domain
Certbot / ACME email
```

The initial administrator password should **not** be requested from the user.

The rest should be:

- generated securely
- derived
- detected from the machine
- or hardcoded as safe StackPort defaults

Examples that should not be asked interactively:

```text
JWT secret
session secret
internal API secret
Docker network name
internal service ports
database file path
proxy container name
Certbot webroot path
```

---

# 4. Persistent Configuration

## 4.1 Non-secret configuration

Recommended file:

```text
/etc/stackport/stackport.env
```

Example:

```dotenv
STACKPORT_DOMAIN=stackport.example.com
CERTBOT_EMAIL=admin@example.com

NODE_ENV=production
LOG_LEVEL=info
```

Permissions may generally be:

```bash
chmod 640 /etc/stackport/stackport.env
```

depending on the runtime user/group model.

---

## 4.2 Generated secrets

Recommended file:

```text
/etc/stackport/secrets.env
```

Example:

```dotenv
JWT_SECRET=...
SESSION_SECRET=...
ENCRYPTION_KEY=...
```

Permissions:

```bash
chmod 600 /etc/stackport/secrets.env
```

Directory:

```bash
chmod 700 /etc/stackport
```

Generated secrets must be created **once** and reused across:

- restart
- reboot
- redeploy
- update
- repair
- systemd-to-Docker migration

Example helper:

```bash
generate_secret_if_missing() {
    local key="$1"
    local file="/etc/stackport/secrets.env"

    if ! grep -q "^${key}=" "$file" 2>/dev/null; then
        local value
        value="$(openssl rand -hex 32)"
        printf '%s=%s\n' "$key" "$value" >> "$file"
    fi
}
```

Example:

```bash
generate_secret_if_missing "JWT_SECRET"
generate_secret_if_missing "SESSION_SECRET"
generate_secret_if_missing "ENCRYPTION_KEY"
```

Do not regenerate a JWT secret during ordinary startup.

Doing so would invalidate every JWT signed with the previous key.

---

# 5. Bootstrap Administrator

## 5.1 Do not ask the installer for an admin password

Instead, first installation should generate a temporary bootstrap login.

Conceptually:

```text
Username: admin
Password: <random temporary password>
```

The temporary password should be displayed **once**.

Recommended generation is stronger than 8 Base32 characters.

Eight Base32 characters provide only about 40 bits of entropy.

Prefer approximately 16 Base32 characters or equivalent.

Example:

```bash
openssl rand 10 | base32 | tr -d '='
```

A formatted value may look like:

```text
K7XM4-QPND2-WR9BH-F3JK
```

---

## 5.2 Bootstrap account is not a normal superadmin

The bootstrap identity must be limited to installation completion.

Suggested server-side state:

```text
username
password_hash
bootstrap = true
expires_at
consumed_at
```

A successful bootstrap login should create a **restricted bootstrap session**, not a regular superadmin session.

Allowed operations should be limited to something equivalent to:

```text
GET  /api/me
POST /api/setup/admin
POST /api/logout
```

Normal application APIs must remain inaccessible.

Examples that must be denied:

```text
GET    /api/projects
POST   /api/projects
GET    /api/users
DELETE /api/projects/*
GET    /api/secrets/*
```

The frontend redirect is not sufficient; the backend must enforce the restriction.

---

## 5.3 Bootstrap completion

Preferred flow:

```text
temporary "admin" login
        ↓
restricted setup session
        ↓
create real superadmin
        ↓
transaction commits
        ↓
invalidate/delete bootstrap identity
        ↓
mark installation initialized
```

Persist an installation state such as:

```text
installation_initialized = true
```

After this point, the bootstrap account must never become usable again.

Rerunning:

```bash
stackport install
```

must **not** recreate it.

---

## 5.4 Do not consume bootstrap credentials too early

Do not permanently invalidate the bootstrap credential immediately after password verification.

If the browser crashes during setup, the operator could become locked out.

Prefer:

```text
login
  ↓
restricted bootstrap session
  ↓
real admin successfully created
  ↓
bootstrap credential consumed
```

The actual state change should be transactional where practical.

---

# 6. Administrator Recovery

StackPort should support emergency administrator recovery.

Command:

```bash
sudo stackport admin-recovery
```

This should not be called `reinstall-admin`.

Recovery is a privileged emergency operation, not part of normal installation.

---

## 6.1 Recovery security boundary

Recovery must require host root access.

Example:

```bash
require_root() {
    if [[ "$EUID" -ne 0 ]]; then
        echo "ERROR: administrator recovery requires root." >&2
        exit 1
    fi
}
```

Strongly consider requiring an interactive TTY:

```bash
if [[ ! -t 0 ]]; then
    echo "ERROR: administrator recovery must be run interactively." >&2
    exit 1
fi
```

There should be no unauthenticated HTTP endpoint that activates admin recovery.

---

## 6.2 Recovery credential

Recovery should reuse the bootstrap-style security model without resurrecting the original bootstrap account.

Example output:

```text
StackPort administrator recovery enabled.

URL:      https://stackport.example.com
Username: recovery
Password: 7GTPK-J4XMQ-H2RND-F8CZP

This credential is temporary and only permits
administrator recovery.

Expires in 30 minutes.
```

Store only a hash of the temporary password.

Suggested state:

```text
recovery credential
├── password_hash
├── created_at
├── expires_at
└── consumed_at
```

Creating a new recovery credential should invalidate any previous unused recovery credential.

---

## 6.3 Recovery session permissions

The recovery session should allow only operations such as:

```text
reset password for an existing superadmin
create a replacement superadmin
logout
```

It should not permit:

```text
project deployment
project deletion
reading application secrets
reading backup contents
changing proxy configuration
arbitrary container actions
```

The goal is account recovery, not temporary full operational access.

---

# 7. Command Semantics

## 7.1 `stackport install`

Purpose:

> Install StackPort or safely reconcile an incomplete existing installation.

Typical steps:

```text
verify root
verify supported OS
verify/install Docker
create persistent directories
create non-secret configuration
generate missing machine secrets
configure firewall
create StackPort Docker networks
install/update host CLI
download/pull required StackPort images
start StackPort infrastructure
initialize database if fresh
generate bootstrap admin only if truly uninitialized
obtain certificate if missing
run health checks
```

Pseudo-shell:

```bash
install_stackport() {
    ensure_supported_os
    ensure_docker
    ensure_directories
    ensure_configuration
    ensure_secrets
    ensure_firewall
    ensure_stackport_network
    ensure_cli
    pull_stackport
    start_stackport
    ensure_database
    ensure_initial_bootstrap
    ensure_certificate
    healthcheck_stackport
}
```

`install` must be idempotent.

---

## 7.2 `stackport update`

Definition:

> Update StackPort itself.

This command does **not** mean:

- update managed projects
- update Docker
- update Ubuntu packages
- update Nginx just because a newer image exists
- update Certbot just because a newer image exists
- redeploy managed applications

Managed project deployment stays inside StackPort.

Target behavior:

```text
check target StackPort version
        ↓
pull new StackPort image
        ↓
create safe backup/snapshot
        ↓
record current version for rollback
        ↓
handoff update to external updater
        ↓
replace StackPort container
        ↓
run compatible migrations/startup
        ↓
health check
        ↓
success → commit update
failure → rollback
```

---

## 7.3 `stackport rollback`

Purpose:

> Roll StackPort itself back to the previous known-good StackPort version.

It does not roll back managed projects.

Rollback should restore:

- prior StackPort image/version
- configuration version if required
- StackPort database backup when a migration requires it

Managed project containers and project data must remain untouched.

---

## 7.4 `stackport status`

Should perform non-destructive inspection.

Recommended checks:

```text
StackPort version
previous version
container state
health endpoint
proxy state
certificate existence/expiry
persistent directory permissions
StackPort DB accessibility
Docker availability
required Docker network
firewall state
bootstrap/recovery state
last update result
```

The command should not mutate the system unless a clearly documented harmless refresh is unavoidable.

---

## 7.5 `stackport repair`

Purpose:

> Reconcile StackPort-owned infrastructure without changing user/application state.

Examples:

- recreate missing generated proxy configuration
- recreate required Docker network
- restore expected directory permissions
- recreate missing non-secret runtime files
- restart unhealthy StackPort infrastructure
- validate Compose configuration

`repair` must not:

- create a new admin
- reset an admin password
- rotate secrets
- delete project data
- purge certificates
- wipe databases

Recovery of administrators belongs only to:

```bash
stackport admin-recovery
```

---

## 7.6 `stackport admin-recovery`

Purpose:

> Explicit root-only recovery of administrator access.

Flow:

```text
verify root
verify interactive execution
inspect current admin state
ask explicit confirmation
invalidate prior recovery token
generate temporary recovery credential
store hash + expiration
print credential once
user completes restricted web recovery
consume credential
```

---

## 7.7 `stackport uninstall`

Default uninstall should remove StackPort runtime while preserving recoverable state.

Recommended removal:

```text
StackPort containers
StackPort proxy/certbot containers
StackPort-specific temporary runtime
StackPort-specific Docker networks when unused
host CLI if desired
```

Recommended preservation:

```text
/var/lib/stackport/data
/var/lib/stackport/backups
/etc/stackport
database
machine secrets
project metadata
certificates
```

This makes later reinstall/recovery possible.

Do not uninstall Docker itself.

Docker may now be used by workloads unrelated to StackPort.

Do not blindly reset UFW.

Remove only firewall rules StackPort can positively identify as StackPort-owned.

---

## 7.8 `stackport uninstall --purge`

This is destructive.

It may remove:

```text
/etc/stackport
/var/lib/stackport
StackPort DB
StackPort backups
StackPort-generated secrets
StackPort-generated certificates
StackPort-owned persistent volumes
StackPort runtime configuration
```

Require a strong interactive confirmation.

Example:

```text
This permanently deletes StackPort state, users,
secrets, configuration and backups.

Type DELETE STACKPORT to continue:
```

Automation/noninteractive purge should be disallowed unless a future explicit force flag is deliberately designed.

---

# 8. Safe Backup Strategy

Backups are required before StackPort self-update whenever persistent StackPort state may change.

Recommended location:

```text
/var/lib/stackport/backups/
```

Example:

```text
/var/lib/stackport/backups/
├── update-1.4.2-to-1.5.0-20260816-144000/
│   ├── manifest.json
│   ├── stackport-db.sqlite
│   ├── stackport.env
│   ├── compose/
│   └── metadata/
```

Do not casually duplicate secret files into every backup.

If secret recovery is required, either:

- reference the persistent secret store
- copy secrets only into a root-only encrypted/permission-restricted backup
- or explicitly mark secrets as external to the snapshot

Backups should never loosen permissions.

---

## 8.1 Backup manifest

Each update backup should contain a manifest such as:

```json
{
  "createdAt": "2026-08-16T14:40:00-03:00",
  "reason": "stackport-update",
  "fromVersion": "1.4.2",
  "toVersion": "1.5.0",
  "databaseBackup": "stackport-db.sqlite",
  "configVersion": 3,
  "migrationVersion": 12
}
```

This makes rollback deterministic.

---

## 8.2 Backup creation should fail closed

If an update requires a backup and the backup cannot be created or verified:

```text
DO NOT CONTINUE THE UPDATE
```

Examples:

- database copy failed
- insufficient disk space
- backup destination unavailable
- backup validation failed

Prefer a failed update attempt over an unrecoverable migration.

---

## 8.3 Back up before migrations

Correct ordering:

```text
pull image
validate target
create backup
verify backup
record rollback state
run migration/start replacement
```

Not:

```text
run migration
then try to back up
```

---

# 9. Migration and Rollback Safety

Container rollback is easy.

Database rollback is not.

Therefore StackPort schema changes should prefer backward-compatible migrations.

Preferred pattern:

```text
v1.4 schema
   ↓
v1.5 adds nullable/new structures
   ↓
both v1.4 and v1.5 can still operate
```

Avoid destructive changes in the same release where possible.

For changes that cannot be backward compatible:

```text
backup DB
apply migration
start new version
health check
```

If health check fails:

```text
stop failed version
restore DB backup
restore previous StackPort version
health check previous version
```

Rollback success itself must be verified.

---

# 10. StackPort Self-Update Architecture

The main StackPort container should not be responsible for destroying/replacing itself through a fragile synchronous shell process.

Use an external updater/handoff model.

```text
StackPort app
     │
     │ request update
     ▼
StackPort updater
     │
     ├── pull
     ├── backup
     ├── replace
     ├── healthcheck
     └── rollback
```

The updater can be:

- a small dedicated container
- or a host-side helper launched by `stackport`

The important property is:

> The updater remains alive while the main StackPort container is replaced.

---

## 10.1 Same update engine from CLI and UI

Avoid separate implementations.

Desired architecture:

```text
SSH
 │
 └── stackport update ─────┐
                           │
                           ▼
                    StackPort updater
                           ▲
                           │
StackPort Admin UI ────────┘
```

The admin UI should request the same update mechanism used by:

```bash
sudo stackport update
```

This avoids divergent behavior.

---

## 10.2 Explicit image versions

Prefer:

```yaml
services:
  stackport:
    image: ghcr.io/mattediworks/stackport:${STACKPORT_VERSION}
```

with:

```dotenv
STACKPORT_VERSION=1.5.0
```

Avoid relying exclusively on:

```text
latest
```

Explicit versions allow deterministic rollback.

Persist update state, for example:

```text
/var/lib/stackport/update/state.json
```

Conceptually:

```json
{
  "current": "1.5.0",
  "previous": "1.4.2",
  "lastUpdate": "success"
}
```

---

# 11. WebSocket Behavior During StackPort Update

StackPort WebSocket connections will disconnect when the StackPort container is replaced.

This is expected.

The frontend should treat WebSocket connections as recoverable:

```text
connected
   ↓
update begins
   ↓
StackPort stops
   ↓
WS disconnects
   ↓
frontend shows restarting/updating state
   ↓
retry health/reconnect
   ↓
new StackPort healthy
   ↓
reload/reconnect
```

For the first implementation, do not build a complex temporary updater WebSocket service.

A simple UI state such as:

```text
StackPort is restarting...
```

plus health polling/reconnection is sufficient.

The reverse proxy should remain alive during the StackPort app replacement.

---

# 12. Proxy and Docker Networking

Final target:

```text
Internet
   │
   ├── 80
   ├── 443
   └── 8883
        │
        ▼
StackPort-owned ingress
        │
        ▼
Docker internal networks
```

Managed applications must not publish host ports themselves.

---

## 12.1 Managed application contract

Forbidden:

```yaml
services:
  app:
    ports:
      - "3000:3000"
```

Allowed:

```yaml
services:
  app:
    expose:
      - "3000"
```

or simply internal Docker networking where `expose` is unnecessary.

Also reject or tightly control:

```yaml
network_mode: host
```

because it bypasses the no-host-port model.

Potentially restrict:

```yaml
privileged: true
```

and other dangerous host-level features according to StackPort security policy.

---

## 12.2 Architectural invariant

StackPort should maintain this rule:

> Managed applications do not decide what the VPS exposes publicly. StackPort decides what the VPS exposes.

HTTP/HTTPS services are routed through the StackPort proxy.

Native MQTTS is infrastructure-managed.

Plain public MQTT should not be enabled by default.

---

# 13. Firewall Policy

For the intended default VPS:

```text
22/tcp    SSH
80/tcp    HTTP
443/tcp   HTTPS
8883/tcp  MQTTS
```

All other inbound traffic should be denied.

Outbound traffic may remain allowed by default.

Conceptual UFW setup:

```bash
ufw default deny incoming
ufw default allow outgoing

ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 8883/tcp comment 'MQTTS'

ufw --force enable
```

Before enabling the firewall:

- verify the actual SSH port
- add the SSH allow rule first
- preserve the active session
- ideally test a second SSH connection

IPv6 must be covered as well.

---

## 13.1 Docker port policy is primary

Because StackPort-managed applications are forbidden from publishing host ports, firewall rules do not need to compensate for arbitrary application port mappings during normal operation.

The stronger invariant is:

```text
managed app ports: forbidden
StackPort ingress ports: explicitly controlled
```

A `DOCKER-USER` defense-in-depth policy may still be added later to protect against:

- manual `docker run -p`
- a StackPort bug
- an unexpected Compose mutation

But it should not be the primary application isolation mechanism.

---

# 14. MQTTS Policy

Recommended public exposure:

```text
8883/tcp  MQTTS  allowed
1883/tcp  MQTT   blocked publicly
```

Plain MQTT may exist internally:

```text
Docker private network
LAN
VPN/tunnel
```

but public native MQTT should require TLS.

TLS alone is not sufficient; public brokers should also require:

- authentication
- topic ACLs
- appropriate broker hardening

If a managed MQTT broker requires public MQTTS, StackPort should own the public exposure rather than allowing the managed application to publish `8883` itself.

---

# 15. Suggested Directory Ownership Model

```text
/etc/stackport/
    machine configuration and secrets

/var/lib/stackport/
    persistent StackPort state

/usr/local/bin/stackport
    host management CLI
```

Example:

```text
/etc/stackport/
├── stackport.env
├── secrets.env
└── install.conf

/var/lib/stackport/
├── backups/
├── compose/
├── data/
├── nginx/
├── letsencrypt/
├── certbot/
└── update/
```

The application checkout/container image should be disposable.

Persistent data must not live only inside the container filesystem.

---

# 16. Safe Uninstall Model

Normal uninstall:

```bash
stackport uninstall
```

means:

> remove the StackPort runtime while preserving the ability to recover/reinstall.

Purge:

```bash
stackport uninstall --purge
```

means:

> permanently remove StackPort-owned state.

This distinction must be preserved.

---

# 17. Safe Reinstall Model

A later:

```bash
stackport install
```

after non-purge uninstall should:

```text
detect preserved installation state
reuse existing secrets
reuse existing database
reuse existing certificate where valid
restore infrastructure
start existing StackPort installation
```

It must not create another bootstrap admin merely because the runtime had previously been removed.

The source of truth is persistent initialization state, not whether a bootstrap row currently exists.

---

# 18. Recommended CLI Skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-}"

usage() {
    cat <<'EOF'
Usage:
  stackport install
  stackport update
  stackport rollback
  stackport status
  stackport repair
  stackport admin-recovery
  stackport uninstall
  stackport uninstall --purge
EOF
}

require_root() {
    if [[ "$EUID" -ne 0 ]]; then
        echo "ERROR: StackPort management requires root." >&2
        exit 1
    fi
}

case "$COMMAND" in
    install)
        require_root
        install_stackport
        ;;

    update)
        require_root
        update_stackport
        ;;

    rollback)
        require_root
        rollback_stackport
        ;;

    status)
        status_stackport
        ;;

    repair)
        require_root
        repair_stackport
        ;;

    admin-recovery)
        require_root
        admin_recovery
        ;;

    uninstall)
        require_root
        uninstall_stackport "${2:-}"
        ;;

    help|-h|--help)
        usage
        ;;

    *)
        usage
        exit 1
        ;;
esac
```

---

# 19. Suggested Internal Functions

A possible implementation breakdown:

```bash
ensure_supported_os
ensure_root
ensure_docker
ensure_directories
ensure_configuration
ensure_secrets
ensure_firewall
ensure_stackport_network
ensure_cli
ensure_database
ensure_initial_bootstrap
ensure_certificate

pull_stackport
start_stackport
stop_stackport
healthcheck_stackport

create_update_backup
verify_update_backup
launch_updater
rollback_stackport

create_admin_recovery
invalidate_admin_recovery

repair_stackport
uninstall_stackport
purge_stackport
```

Each function should have a narrow responsibility.

Avoid large install functions containing destructive ad-hoc shell logic.

---

# 20. Failure Handling

The lifecycle tool should use:

```bash
set -euo pipefail
```

but critical operations still need explicit error handling where rollback or cleanup is required.

Examples:

```text
certificate failure
    → leave current StackPort running where possible

update image pull failure
    → do not stop current version

backup failure
    → do not migrate/update

new version healthcheck failure
    → rollback

rollback healthcheck failure
    → report critical recovery state clearly
```

Never print secrets in error traces.

---

# 21. Logging

Lifecycle actions should produce concise operator-visible logs.

Example:

```text
[stackport] checking Docker
[stackport] persistent configuration found
[stackport] JWT secret already provisioned
[stackport] pulling StackPort 1.5.0
[stackport] creating update backup
[stackport] replacing StackPort container
[stackport] health check passed
[stackport] update complete
```

Do not log:

- plaintext bootstrap password after initial display
- permanent passwords
- JWT secrets
- session secrets
- encryption keys

Recovery/bootstrap credentials should be printed only when generated and should not be written to general logs.

---

# 22. Bootstrap and Recovery Backup Rules

Before actions that can change authentication state:

```text
admin recovery
database migration affecting users/auth
destructive repair
```

StackPort should ensure that the user/account database is recoverable.

For `admin-recovery`, do not overwrite existing admins.

Preferred behavior:

```text
existing superadmin(s)
        +
temporary recovery credential
```

Recovery should only modify a real admin after the operator explicitly completes the recovery flow.

This avoids turning the recovery command itself into an immediate destructive password reset.

---

# 23. Security Invariants

The implementation should preserve the following invariants.

1. Machine secrets are generated once and survive normal lifecycle operations.
2. `stackport install` never recreates bootstrap access on an initialized installation.
3. Bootstrap sessions cannot operate StackPort normally.
4. Recovery requires local root authorization.
5. Recovery sessions cannot operate StackPort normally.
6. Temporary credentials expire and are single-use.
7. Managed applications cannot publish host ports.
8. Managed applications cannot use host networking.
9. StackPort owns all deliberate public ingress.
10. Public MQTT uses MQTTS rather than plaintext MQTT by default.
11. StackPort updates do not redeploy managed applications.
12. Update backup happens before migrations.
13. Failed update health checks trigger rollback.
14. `uninstall` preserves state by default.
15. `uninstall --purge` is explicit and strongly confirmed.
16. Docker itself is never removed automatically by StackPort uninstall.
17. Firewall configuration is not globally reset during uninstall.
18. Secrets must never be printed in general logs.

---

# 24. Initial Implementation Order

A practical implementation sequence:

```text
Phase 1
    stackport install
    stackport status
    persistent config/secrets
    one-time bootstrap admin

Phase 2
    stackport admin-recovery
    safe uninstall
    purge mode

Phase 3
    Dockerized StackPort
    Dockerized proxy
    Dockerized Certbot
    managed app no-port enforcement

Phase 4
    stackport update
    external updater handoff
    automatic backups
    health-check rollback

Phase 5
    stackport rollback
    migration-aware DB restore
    hardened DOCKER-USER defense-in-depth
```

---

# 25. Final Operator Experience

First use:

```bash
curl -fsSL <stackport-install-url> -o stackport.sh
chmod +x stackport.sh
sudo ./stackport.sh install
```

Installation asks only for minimal deployment-specific values and then prints the one-time bootstrap credential.

After installation:

```bash
stackport status
sudo stackport update
sudo stackport rollback
sudo stackport repair
sudo stackport admin-recovery
sudo stackport uninstall
sudo stackport uninstall --purge
```

The intended result is an appliance-like StackPort installation where:

- the host remains simple
- StackPort owns its infrastructure
- projects remain isolated from host ingress
- upgrades are recoverable
- first-admin setup is safe
- administrator recovery is explicit
- destructive actions are difficult to trigger accidentally
