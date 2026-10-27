# Security work not done in 1.2

Every item here was held back on purpose: most change what a deployed project is
allowed to do, so each needs a design that checks what existing installs rely on
before anything is enforced. Ratings are explained in [README.md](README.md).

**The threat model these items share:** anyone who can push to a repository that
Stackport deploys (a collaborator, a compromised CI token, a dependency that rewrites
the Compose file) controls what `docker compose up` runs. Stackport holds the Docker
socket, which is root on the host. So today, repository content can reach the host.

## Isolation of deployed projects

### S14 — Run `docker compose` with a minimal environment · 🔴 · S

**Problem.** `dotenv` loads Stackport's own `.env` into `process.env`, and
`dockerEnv()` (`src/services/projectDeploy.ts`) passes all of it to every
`docker compose` run. Compose interpolates `${VAR}` from that environment, so any
project's Compose file can read Stackport's secrets:

```yaml
services:
  web:
    image: alpine
    environment:
      STOLEN: ${JWT_SECRET}   # also WEBHOOK_SECRET, STACKPORT_REPO_TOKEN
```

`JWT_SECRET` signs admin sessions **and** is the key the stored credentials (GitHub
tokens, API keys) are encrypted with (`src/utils/crypto.ts`). One leaked value gives
admin access and every stored credential. No policy bypass is needed: this is plain
interpolation.

**Fix.** Pass `docker compose` only `PATH`, `HOME`, `DOCKER_CONFIG` and `DOCKER_HOST`.
Compose still reads the project's own root `.env` by itself.

**Deployed installs.** A project whose Compose file uses a `${VAR}` that only existed
in Stackport's environment would get an empty value. Before enforcing, log every
`${VAR}` a deploy can no longer resolve (the Compose variables scan from PR 15 already
lists them), so a breakage is visible.

**Also do.** Rotate `JWT_SECRET` (and with it, re-encrypt credentials: see S7) on any
install where an untrusted repository has been deployed.

### S1 — Compose policy: allowlist the resolved config · 🔴 · L

**Problem.** `src/services/composePolicy.ts` checks the raw YAML against a denylist.
Eight demonstrated bypasses, each a working Compose file:

| Case | How | Result |
|---|---|---|
| a | `volumes: ["${HOSTROOT:-/}:/host"]` | Host root mounted; the check sees the unresolved string |
| b | `privileged: ${PRIV:-true}` | Privileged container; the check sees a string, not `true` |
| c | Named volume with `driver_opts: {type: none, o: bind, device: /}` | Host root bind-mounted through a volume |
| d | `include: [extra.yml]` with the dangerous service in `extra.yml` | Only the top file is checked |
| e | `cap_add: [SYS_MODULE, SYS_PTRACE]`, `security_opt: [seccomp:unconfined]`, `userns_mode: host` | Only `ALL` and `SYS_ADMIN` are denied |
| f | `build: {context: /}` | Builds with the host's root as context |
| g | `secrets: {x: {file: /etc/shadow}}` | Reads any host file |
| h | `volumes_from: ["container:stackport"]`, `network_mode`/`pid: container:stackport` | Joins Stackport's container: the Docker socket and its secrets |

**Fix.** Validate the output of `docker compose config --format json` (variables
resolved, includes merged, run with S14's minimal environment) against an
**allowlist** of keys and values, per service and for top-level `volumes`, `secrets`,
`configs` and `networks`. Anything not explicitly allowed is rejected with the
service, key and fix (the 1.2 violations table already renders that).

**Deployed installs.** Run in warn-only mode for one release: log and show what would
be rejected, deploy anyway. Then enforce.

### S2 — Volume model: Stackport-owned mount directories · 🔴 · L · needs S1

**Problem.** Bind mounts point wherever the Compose file says; relative paths resolve
inside the checkout, where a symlink committed to the repository can point anywhere.

**Fix.** Host paths are always `<prefix>/<project>/<name>`, created and owned by
Stackport; the Compose file names a volume, never a host path. Symlinks are refused
when the directory is created and when it is resolved (see S12).

**Deployed installs.** Existing bind mounts need a migration path: copy the data into
the new directory on the first deploy after the change, with a dry run first. This is
the largest risk in the whole list, because it touches project data.

### S8 — Hardened container defaults · 🟠 · M · needs S1

Apply `no-new-privileges`, `cap_drop: [ALL]` plus the allowlisted additions, and a
default memory and PID limit to every managed service, unless the admin allows an
exception per project. Needs S1 so the defaults can't be overridden from the Compose
file.

### S11 — Docker socket containment · 🟠 · XL

Stackport mounts `/var/run/docker.sock`, which is root on the host. Options:
user-namespace remapping, a filtering socket proxy that allows only the API calls
Stackport needs, or rootless Docker. Must account for the self-update path
(`src/services/selfUpdate.ts`), which starts a container with the host's whole `/`
mounted and `chroot`s into it to run `stackport.sh`; whatever contains the socket has
to keep that working or replace it.

## Network

### S3 — Take Stackport off the `stackport-proxy` network · 🟠 · M

The `stackport` container joins `stackport-proxy`, the network every routed project
joins, so any project can call Stackport's API directly instead of through nginx.
Give nginx and Stackport their own network for the admin route and keep only nginx on
`stackport-proxy`.

### S4 — Narrow `trust proxy` · 🟠 · S

`app.set("trust proxy", ["loopback", "uniquelocal"])` trusts every private address,
which includes every project container. A project can send `X-Forwarded-For` with any
value and get past the login rate limit. Trust only the nginx container's address (or
fix S3 first, after which only nginx can reach the app).

### S9 — Per-project ingress networks · 🟡 · M · needs S3

All routed projects share `stackport-proxy`, so they can reach each other. One network
per project, joined by nginx and that project only.

### S10 — Block cloud metadata and LAN egress · 🟡 · M

Project containers can reach `169.254.169.254` (cloud credentials on most providers)
and the host's LAN. Needs `DOCKER-USER` iptables rules on the host. Stackport has no
host agent, so this goes through `stackport.sh` (install, update and repair), not the
app.

## Sessions, keys and stored secrets

### S6 — Session lifetime cap, httpOnly cookie · 🟡 · M

The session token sits in `localStorage` (readable by any script on the page) and its
expiry slides forward on every use, with no absolute limit. Move it to an httpOnly,
`SameSite=Strict` cookie (the Socket.IO handshake and the API both need it), add CSRF
protection for state-changing requests, and cap a session's total lifetime.

### S7 — Separate encryption key, with versioning · 🟡 · M

Stored credentials are encrypted with a key derived from `JWT_SECRET`, so rotating
the session secret breaks every credential, and leaking it (S14) exposes them. Give
encryption its own key, prefix each ciphertext with a key version, and add a
re-encryption migration so either key can rotate.

### S13 — Encrypt managed env values at rest · 🟡 · M · needs S7

`project_env_files.variables_json` holds project environment values in plain text,
unlike credentials. Encrypt them with S7's key; decrypt only when writing the `.env`
file a deploy uses. Found during PR 8.

### S5 (rest) — Write access over MCP · 🟠 · L · needs S6

1.2 ships a read-only MCP with scoped tokens (`read`). Write tools (deploy, roll back,
restart) need a `write` scope, per-token project limits, an audit entry per call, and
a confirmation step for destructive tools. Do S6 first so a stolen browser session
can't mint tokens.

### S12 — `resolveContainedPath` should resolve symlinks · 🟡 · S

`src/utils/safePath.ts` checks containment lexically. A symlink inside the root can
point outside it. Resolve with `realpath` before the containment check. Unverified
whether anything exploitable relies on it today; fixing it is cheap and S2 needs it.
