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
`dockerEnv()` (`src/modules/deployments/operations.ts`) passes all of it to every
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
tokens, API keys) are encrypted with (`src/shared/crypto.ts`). One leaked value gives
admin access and every stored credential. No policy bypass is needed: this is plain
interpolation.

**Fix.** Pass `docker compose` only `PATH`, `HOME`, `DOCKER_CONFIG` and `DOCKER_HOST`.
Compose still reads the project's own root `.env` by itself.

**Deployed installs.** A project whose Compose file uses a `${VAR}` that only existed
in Stackport's environment would get an empty value. Before enforcing, log every
`${VAR}` a deploy can no longer resolve (the Compose variables scan from PR 15 already
lists them), so a breakage is visible.

**Status: done.** `docker compose` now gets only the allowlisted variables
(`buildDockerEnv`: the docker client settings, the Windows basics, and the proxy,
certificate and `DOCKER_API_VERSION` variables a host behind a proxy needs), and a deploy warns by name about each `${VAR}` that Stackport's
environment used to supply.

**Also do.** Rotate `JWT_SECRET` (and with it, re-encrypt credentials: see S7) on any
install where an untrusted repository has been deployed.

### S1 — Compose policy: allowlist the resolved config · 🔴 · L

**Problem.** `src/modules/deployments/compose/policy.ts` checks the raw YAML against a denylist.
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

**Status: done (a–h), with one change to the rollout.** Projects created after this
change are enforced; projects that already existed (migration 008,
`projects.compose_policy_enforced = 0`) deploy and log what a new project would be
rejected for. There is no setting to enforce an existing project yet: add one before
the next release.

The check runs before `up`, `config` and **`build`**. A build reads its context and Dockerfile from
Stackport's own disk and sends them to the Docker daemon, so `build.context: /app/data` copied Stackport's
files into an image (and a `RUN` could send them out) without any container starting. The Build action and
the first step of a forced rebuild skipped the check until this was found in review.

What the resolved config is held to (`validateResolvedComposePolicy`):

| Case | Rule |
|---|---|
| a | Bind sources inside the project folder; named volumes and tmpfs only otherwise |
| b | Resolved `privileged` (the denylist, now on resolved values) |
| c | Top-level volumes: `local` driver, no bind/rbind options |
| d | `include:` is merged before checking (proved with real `docker compose config`) |
| e | `cap_add` allowlist (`NET_ADMIN` is allowed), `security_opt` only `no-new-privileges`, no `userns_mode`, `uts`/`cgroup: host` |
| f | `build.context` and `additional_contexts` host paths inside the project folder |
| g | `secrets`/`configs` `file:` inside the project folder |
| h | `volumes_from`, `network_mode`, `pid`, `ipc` may only name a service of the same project |

The config is resolved once per deploy with every profile on (`docker compose --profile '*'
config`, so a service behind `profiles:` is checked too), and the same result feeds the
mount rewrite and the hardening. A project that enforces the policy is refused when the file
cannot be resolved (error, timeout, output over 32 MB); older projects get a warning.

Also refused, found in review: any file Compose reads from Stackport's own filesystem outside
the project (`env_file`, `include`, `extends.file`, `build.dockerfile`, checked in the raw YAML
and in every included file, for every project, because an absolute `env_file: /app/.env` copied
the app's secrets into a service), external networks other than the shared ingress network (S9) and networks
or volumes that do not carry the project's name (a service could join `stackport_default`, where
the admin API listens, or attach to another project's volume), external volumes, and non-bridge
network drivers. The project's policy panel shows the raw-file results too.

### S2 — Volume model: Stackport-owned mount directories · 🔴 · L · needs S1

**Problem.** Bind mounts point wherever the Compose file says; relative paths resolve
inside the checkout, where a symlink committed to the repository can point anywhere.

**Fix.** Host paths are always `<prefix>/<project>/<name>`, created and owned by
Stackport; the Compose file names a volume, never a host path. Symlinks are refused
when the directory is created and when it is resolved (see S12).

**Deployed installs.** Existing bind mounts need a migration path: copy the data into
the new directory on the first deploy after the change, with a dry run first. This is
the largest risk in the whole list, because it touches project data.

**Status: built, not yet run on a real host.** What shipped differs from the text above
in two ways, both from finding that Stackport runs `docker compose` inside its own
container: a relative `./data` resolves to a container path that the host's Docker
daemon reads as a host path.

- Mounts are not forbidden. For a project with `volumes_managed = 1`, a deploy resolves
  the Compose file, creates `<data>/volumes/<project>/<name>`, and passes a generated
  override that re-points each bind mount into the checkout: a writable directory goes
  to its managed directory, a read-only mount (repository config files) keeps its place
  with the path translated to the host, and what cannot move (a file, or the whole
  checkout writable) is kept the same way and reported. `managedVolumes.ts` plans it.
- A new managed directory is filled once from the repository's folder of the same path (a writable
  `./config` or `./data` that ships default or seed files), so the container still sees them.
  `seedVolumes.ts` copies into `<dir>.seeding`, checks it against the source (names, sizes, link
  targets) and renames it into place, so an interrupted copy never leaves a half-filled directory. Links are
  copied as links, not followed. It happens only when the directory does not exist yet: never into an
  existing one (not even an empty one), and never again, so nothing the application wrote is overwritten.
  A failed copy fails the deploy with the reason.
- New projects are managed from the start. Existing ones (migration 009) keep their
  current mounts until **Settings > Migrations** copies their data (a helper container
  runs `cp -a`, so ownership survives), leaves the originals in place, and switches
  them over. It has a dry run, and it skips a project whose containers are running or whose state
  cannot be read (a copy of live data loses writes), blocks one on a failed copy, on data found in
  two places, or on a copy that does not match the original (a read-only `diff -rq` after the copy).
  Directory names come from the mount's path alone (`<path>-<hash>`), so they never change. A second entry removes the original
  directories afterwards. It re-checks right before deleting, because the project may have written to the
  original since the copy (for example after being reverted to the old release): the managed copy must hold
  files and cover everything in the original (a file missing from the copy, or newer in the original, stops
  it, read-only in a helper container), and no container on the host, running or stopped, may mount the
  original or anything inside it. The page is temporary: delete `src/modules/maintenance/migrations`,
  `client/src/pages/settings/migrations` and the lines marked TEMPORARY once installs
  have migrated.

Still to do: symlink refusal (S12).

### S8 — Hardened container defaults · 🟠 · M · needs S1

Apply `no-new-privileges`, `cap_drop: [ALL]` plus the allowlisted additions, and a
default memory and PID limit to every managed service, unless the admin allows an
exception per project. Needs S1 so the defaults can't be overridden from the Compose
file.

**Status: done, with decisions.** Every service of a project with hardened defaults on
gets `no-new-privileges`, a memory limit (default 1024 MB) and a process limit (default
512), through a generated Compose override. Both limits are editable in Settings >
Container defaults (0 turns one off), and a service that declares its own limit keeps
it. Capabilities stay at Docker's defaults: `cap_drop: [ALL]` was left out because it
breaks images whose entrypoints need CHOWN, SETUID or SETGID, and S1 already refuses the
dangerous additions. New projects start with the defaults on; existing ones start off
(migration 011) until an admin switches them on from the project's settings, since a
memory limit can stop a service that has run without one.

### S11 — Docker socket containment · 🟠 · XL

Stackport mounts `/var/run/docker.sock`, which is root on the host. Options:
user-namespace remapping, a filtering socket proxy that allows only the API calls
Stackport needs, or rootless Docker. Must account for the self-update path
(`src/modules/maintenance/selfUpdate.ts`), which starts a container with the host's whole `/`
mounted and `chroot`s into it to run `stackport.sh`; whatever contains the socket has
to keep that working or replace it.

**Status: deferred.** No design has been chosen. The question is which of a filtering socket
proxy, user-namespace remapping or rootless Docker fits, given that `selfUpdate.ts` needs a
container with the host's `/` mounted. Until then, anyone who gets code execution inside the
Stackport container has root on the host.

## Network

### S3 — Take Stackport off the `stackport-proxy` network · 🟠 · M

The `stackport` container joins `stackport-proxy`, the network every routed project
joins, so any project can call Stackport's API directly instead of through nginx.
Give nginx and Stackport their own network for the admin route and keep only nginx on
`stackport-proxy`.

**Status: done.** The app is on the stack's `default` network only; nginx is on both.

### S4 — Narrow `trust proxy` · 🟠 · S

`app.set("trust proxy", ["loopback", "uniquelocal"])` trusts every private address,
which includes every project container. A project can send `X-Forwarded-For` with any
value and get past the login rate limit. Trust only the nginx container's address (or
fix S3 first, after which only nginx can reach the app).

**Status: done.** Loopback and the nginx container's address (looked up by name, every
15 s; `TRUSTED_PROXY_HOST` overrides the name) are trusted; nothing else is. The server
waits for the first lookup (up to 3 s) before it listens, so the first requests already
see nginx as trusted.

### S9 — Unique aliases on the shared ingress network · 🟡 · S (changed in 1.3.1)

The problem: all routed projects share `stackport-proxy`, and nginx reached a service by its plain
name, so two projects with a service called `web` were mixed up by Docker's DNS and nginx could send one
project's domain to the other project's container.

**Status: done in 1.3.1, differently from 1.3.0.** 1.3.0 gave every project its own network
(`stackport-ingress-<id>`). On a server with about 15 projects that exhausted Docker's default address
pool (about 30 networks in all, because every Compose project already has one of its own). Docker answered
`all predefined address pools have been fully subnetted`, the networks for the last seven projects were
never created, nginx's config already named the new aliases, and those projects went down. 1.3.1 keeps the
fix for the name clash and drops the part that cost an address range per project.

- Every routed service joins `stackport-proxy` (declared by the system stack, so nginx is always on it,
  also after nginx is recreated) with the alias `sp<projectId>-<service>`, plus its plain name for
  compatibility. nginx and the TCP proxies use only the alias.
- The Compose rewrite does this on every deploy and removes any `stackport-ingress-*` network a 1.3.0
  deploy had written into the file. At start-up running services are moved the same way (on the shared network
  first, then off the per-project one), so no redeploy is needed.
- At start-up the per-project networks 1.3.0 created are removed once nothing but nginx is on them, which
  gives the address pool back. A network that still has another container is kept and reported.
- Start-up order: services first, then nginx's config, then the TCP proxies, then the clean-up. A project
  that cannot be put on the network is printed with the reason where `docker logs stackport` shows it.
- The policy allows only `stackport-proxy` as an external network, with no aliases of the project's own
  choosing, and refuses a routed service named `stackport` or `sp<number>-…`: on this network service names
  are visible to nginx, so those names could answer for Stackport's admin route or for another project.

**Not done: isolation between projects.** Projects can reach each other's routed services again over
`stackport-proxy`, as before 1.3.0 (S3 still stops them reaching Stackport's own API). Isolation comes back in
1.3.5, with networks drawn from an address range of our own and a check before each switch.

**Docker's address pool is a shared limit.** Each Compose project, each Stackport network group (S15) and
each network you create by hand takes one slot. If a server is near the limit, give Docker a larger pool in
`/etc/docker/daemon.json` (`"default-address-pools": [{"base": "172.80.0.0/12", "size": 24}]`) and restart
Docker; `docker network ls -q | wc -l` shows how many are in use.

### S15 — Network groups · 🟡 · M · needs S9

Two projects that need to talk to each other (an API and a worker kept in
separate projects, a shared database) had no way to do it short of a public domain. A network group
is a supported way, configured in Stackport and never in the Compose file.

**Status: done.**

- A project has a `network_group` (a short lower-case name) and a list of its services that join
  it. Both are set on the project's Settings tab and stored in the database
  (`projects.network_group`, `network_group_services`). It is separate from the project list's
  grouping and from the MCP token scope: neither is touched by it.
- Nothing is shared by default. A project in a group with no service switched on exposes nothing.
- Each group with a joined service has a network `stackport-group-<group>`. A joined service is
  connected to it with `docker network connect --alias <service>.p<projectId>`, not through the
  Compose file: a Compose-declared network also gives the service its plain name there, and `db` in
  one project would then answer for `db` in another. The other projects in the group reach it as
  `db.p7`. A joined service can also reach the others, since a connected container shares the network.
- It is applied to the running containers when the setting changes, after every `up` (new containers
  start without it), and at start-up. Leaving the group or switching a service off disconnects it;
  a group network nothing is connected to is deleted.
- A Compose file cannot opt in. The policy still refuses any external network except the shared
  ingress network, so the people who can push to a repository cannot pull its services into
  someone else's group. Only a signed-in admin changes membership; it is audited as
  `project.network-group`. MCP tokens cannot change it.

- **MCP.** Any token (read or write) can list network groups and see one project's group
  (`stackport_list_network_groups`, `stackport_get_project_network_group`). A write token also gets
  `stackport_set_network_group`, two calls like the other write tools: the first returns what would
  happen, including which other projects gain a path, and a one-time confirmation id; only the second,
  with that id and the same arguments, applies it. A token limited to a project group may only act on
  projects in it **and may not join a network group that has projects outside its project group**,
  checked on both calls, because joining would give its projects a path to services the token could not
  otherwise touch. The stdio MCP (local, trusted) has the same three tools without the confirmation,
  like its other write tools.

Each network group is a Docker network and takes one slot of Docker's address pool (see S9). If creating a group
fails with "all predefined address pools have been fully subnetted", enlarge the pool.

Not covered: a group is a trust boundary of its own. Every joined service can reach every other joined
service in the group on any port, with no per-service rules. Put projects that should not trust each
other in different groups.

### S10 — Block cloud metadata and LAN egress · 🟡 · M

Project containers can reach `169.254.169.254` (cloud credentials on most providers)
and the host's LAN. Needs `DOCKER-USER` iptables rules on the host. Stackport has no
host agent, so this goes through `stackport.sh` (install, update and repair), not the
app.

**Status: deferred.** Needs a Linux host to write and test the `DOCKER-USER` rules. Planned:
an idempotent rule set in `stackport.sh` that drops traffic from the project networks to
`169.254.169.254` by default, and to the private ranges when `STACKPORT_BLOCK_LAN=1`, removed
on uninstall. Until then, a project container can reach the cloud metadata address.

## Sessions, keys and stored secrets

### S6 — Session lifetime cap, httpOnly cookie · 🟡 · M

The session token sits in `localStorage` (readable by any script on the page) and its
expiry slides forward on every use, with no absolute limit. Move it to an httpOnly,
`SameSite=Strict` cookie (the Socket.IO handshake and the API both need it), add CSRF
protection for state-changing requests, and cap a session's total lifetime.

**Status: done.** Login sets an httpOnly, `SameSite=Strict` cookie (`Secure` over HTTPS)
that the web app never sees; a session ends 12 hours after login (`SESSION_MAX_HOURS`) or
after 24 hours unused (`SESSION_IDLE_HOURS`), whichever is first. A cookie-authenticated
request that changes state must send `X-Requested-With: stackport`, and the Socket.IO
handshake must come from the same host. The bearer form still works for scripts, with no
CSRF header, and login returns the token only to a caller that does not send that header.
Everyone is signed out once by the update, and `JWT_EXPIRY` is gone.

A WebSocket was authenticated only when it connected, so it outlived the session: past the 12 hour cap,
after logout, and a container shell opened on it kept working. Now logout closes the sockets opened with that
session, a sweep every 30 seconds closes any whose session has expired, reached its cap or been revoked, and
`shell:start`, `shell:input` and `logs:start` check the session before they act (`sessionGuard.ts`). The
check does not extend the session.

### S7 — Separate encryption key, with versioning · 🟡 · M

Stored credentials are encrypted with a key derived from `JWT_SECRET`, so rotating
the session secret breaks every credential, and leaking it (S14) exposes them. Give
encryption its own key, prefix each ciphertext with a key version, and add a
re-encryption migration so either key can rotate.

**Status: done.** `ENCRYPTION_KEY` (generated into `secrets.env` by install, update and
repair) encrypts new secrets as `v2:<keyId>:<iv>:<tag>:<data>`; `ENCRYPTION_KEY_PREVIOUS`
keeps older keys readable. Old-format values are still read with the JWT-derived key until
**Settings > Migrations > Re-encrypt stored secrets** moves them, after which `JWT_SECRET`
can rotate without breaking them. To rotate the encryption key: put the old value in
`ENCRYPTION_KEY_PREVIOUS`, set a new `ENCRYPTION_KEY`, restart, run the re-encryption, then
drop the previous key.

Two things to know. **Back up `secrets.env`**: without `ENCRYPTION_KEY` the stored credentials
cannot be read. And once secrets are written under the new key, rolling back to a release
older than 1.3 cannot read them. That entry is the one migration worth keeping when the
temporary page is removed, because it also finishes a later key rotation.

### S13 — Encrypt managed env values at rest · 🟡 · M · needs S7

`project_env_files.variables_json` holds project environment values in plain text,
unlike credentials. Encrypt them with S7's key; decrypt only when writing the `.env`
file a deploy uses. Found during PR 8.

**Status: done.** New and edited env files store their values only as ciphertext
(`project_env_files.variables_enc`, migration 013; `variables_json` is `[]`). Files saved
before are encrypted by **Settings > Migrations > Encrypt managed env values**. Env values
are in the re-encryption list, so a key rotation covers them. Rolling back to a release
older than 1.3 deploys an encrypted project with an empty env file, so take the database
backup first and treat a rollback across this change as a restore.

### S5 (rest) — Write access over MCP · 🟠 · L · needs S6

1.2 ships a read-only MCP with scoped tokens (`read`). Write tools (deploy, roll back,
restart) need a `write` scope, per-token project limits, an audit entry per call, and
a confirmation step for destructive tools. Do S6 first so a stolen browser session
can't mint tokens.

**Status: done, with decisions.** A token created with the `write` scope gets four more
tools on `/mcp`: `stackport_deploy_project`, `_rollback_project`, `_restart_project`
(recreates the containers from the images already built, with no pull and no build; refused when the checkout is no longer at the deployed commit, because it would start different code) and `_stop_project`. Each is
two calls: the first changes nothing and returns what would happen plus a one-time
confirmation id (5 minutes, bound to the token, tool, project and arguments); only a
second call that presents it runs the action. That is enforced by the server, not by a
client hint. A write token is for all projects or one project group (`api_tokens.project_group`;
a project with no group is outside every group). The limit applies to writes: reads still
see every project. Every preview, refusal, start and finish is audited with the token as the
actor. The stdio MCP is unchanged in this respect and still local-only. `stackport_set_network_group`
(S15) is a fifth write tool, with the same two-call rule and one extra rule for limited tokens.

Every write tool, on HTTP and on the local stdio server, is marked as destructive in two places an agent
sees before using it: `destructiveHint` in its annotations and a description that starts with
`DESTRUCTIVE:` and says what it interrupts, replaces or overwrites. The server instructions explain the
marker and tell the agent to call such a tool only when the user asked for that change. On stdio this also
covers the tools that overwrite stored data or interrupt routing (update project, pause, domain SSL, env
file replace, nginx reload), which were not marked before.

### G1 — The Git credential was in the command line · 🟠 · M (found in 1.3.5)

Cloning and fetching a private repository ran `git -c http.extraHeader=Authorization: Basic …`. The
arguments of every process are readable by every local user on the host (`ps`, `/proc/<pid>/cmdline`),
so anyone with a shell on the host could read the token for as long as a clone or fetch ran. The same
held for the self-update check with `STACKPORT_REPO_TOKEN`. Logs were already scrubbed, which hid it.

**Status: done (1.3.5).** The credential is passed in the Git process's environment
(`GIT_CONFIG_COUNT`, `_KEY_0`, `_VALUE_0`), which only the process's owner and root can read. See
`src/shared/gitAuth.ts`.

- **Scoped to the repository's origin** (`http.https://github.com/.extraHeader`), not to every host.
  Unscoped, a submodule that points at someone else's server would have received the token.
- **Git gets a minimal environment** (`PATH`, `HOME`, locale, proxy and certificate variables). Stackport's
  own secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, the webhook secret, `STACKPORT_REPO_TOKEN`) are not passed on,
  and Git can never stop to ask for a password (`GIT_TERMINAL_PROMPT=0`).
- **No fallback.** Git older than 2.31 cannot read configuration from the environment; the deploy then
  fails with that reason. It never falls back to the command line.
- Applies to PAT credentials today and will to GitHub App installation tokens. The remote URL and
  `.git/config` never hold a credential.
- A test fails if `extraHeader=` appears in any source file again, and another runs real Git against two
  local servers to show the header reaches only its own origin.

### S12 — `resolveContainedPath` should resolve symlinks · 🟡 · S

`src/shared/safePath.ts` checks containment lexically. A symlink inside the root can
point outside it. Resolve with `realpath` before the containment check. Unverified
whether anything exploitable relies on it today; fixing it is cheap and S2 needs it.

**Status: done.** `resolveContainedPath` resolves the deepest existing part of the path
with `realpath` and refuses a dangling symlink. The compose policy uses the same check
for mounts, build contexts and secret files, so a link out of the project no longer
passes as "inside". Not covered: the managed-mount migration reads each source as the
Docker daemon sees it and does not follow links itself.
