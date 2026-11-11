# GitHub App: operating it

What an admin needs after the App is registered. The design is in [github-app.md](github-app.md); this is what was built
and what is left to a person.

## What exists

| Where | What |
|---|---|
| Settings > GitHub | Preflight, register from a manifest, install and connect accounts, installations and their repository counts, delivery log with replay, credential rotation, forget the App |
| New-project wizard | "The GitHub App" as a way to reach a repository: pick from the connected repositories; no token is typed |
| Project > Settings > GitHub access | Move a project to the App (after a real read of its repository) or back to its token |
| Project > Settings > GitHub access > Deploy when | A push (default), a push once its checks pass (M2), or a published release (M3) |
| Settings > GitHub > Import repositories | Scan an installation for repositories with a Compose file, then create projects from the ones ticked |
| `/api/hooks/github/app` | The App's one webhook: pushes, installation and repository changes, finished checks, releases |
| MCP | `stackport_list_github_repositories` (read) and `stackport_create_project_from_repository` (two-step, destructive-marked) |

Not built: pull-request previews (M4, waits for S11) and naming rollbacks by tag. The manifest requests the M1 to M3
permissions, so nothing needs approving again when a module is used.

## The modules

**M1, report deploys.** Each deploy of an App project is sent to GitHub as a deployment of the commit that was checked out: in
progress when the stack starts, then success (with the project's address) or failure (with a note when it was the health check).
It runs only when the installation approved `deployments: write`, and GitHub being slow, unreachable or refusing never holds up
or fails a deploy.

**M2, deploy after CI** (`Deploy when: a pushed commit's checks pass`). A push is held while any check run or commit status is
running; it deploys when they all pass; it does not deploy when one fails (and the admin gets the usual "deploy blocked"
notification); and a commit with no checks at all deploys after five minutes, so a repository without CI is not held for ever.
A newer push replaces the held one. A commit whose checks never finish is dropped after six hours. Held commits are re-read when
a check suite or workflow run finishes, and once a minute.

**M3, deploy on release** (`Deploy when: a release is published`). Pushes are ignored. A published release (not a draft or
prerelease) deploys the commit its tag resolves to, as GitHub reports it, not the branch tip.

A mode the App was not registered for, or (for CI) whose permissions the installation has not approved, is refused with the reason.

## Importing

Settings > GitHub > an installation > **Import repositories** looks at the default branch of each repository for a Compose file,
shows the result, and creates a project for each one ticked: bound by repository id, on the default branch, named after the
repository (numbered if taken), with a reserved hostname when a default managed domain is set. **Nothing is cloned or deployed.** A
repository that is already a project, has no Compose file, or has no default branch is skipped with the reason and does not stop the
others. At most 100 repositories are looked at, and 50 imported, at a time.

## Before you start

- The Stackport domain is set (Settings > General), served over HTTPS with a certificate GitHub trusts, reachable from the internet. The page says what is missing.
- **Anyone who can push to a connected repository controls what runs on this host.** S11 (Docker socket containment) is not done.

## Registering and connecting

1. Settings > GitHub > **Register on GitHub**. GitHub shows the App with this server's addresses in it; confirm.
2. **Install on an account** (GitHub's page), choose the repositories.
3. **Connect an account**. GitHub asks you to authorize; Stackport uses that one call to list the installations you can access, links this App's, and drops the token. An installation Stackport only hears about (from GitHub's webhook) stays **unlinked** and unusable until this step.
4. **Refresh** an installation to read its repositories, then use them in the wizard, or move an existing project (Project > Settings > GitHub access).

## Moving a project

- **To the App:** Stackport reads the repository with the installation's token first; if GitHub refuses, nothing changes. The match is by repository id.
- **Back to a token:** one click. The project's token was never removed.
- There is no automatic fallback. If the App loses a repository (removed from the installation) or the installation is suspended or removed, the project's deploys and branch checks fail with that reason until you fix it or move the project back.
- A webhook delivery for a project that is not bound to that repository id through a linked installation is ignored, with the reason shown in the delivery log.

## Rotating credentials

**The App's private key** (Settings > GitHub > Rotate credentials): generate a new key in the App's settings on GitHub, paste it. Stackport signs a JWT with
it and asks GitHub who it is; only if GitHub answers with this App's id is the key stored. The old key keeps working on GitHub until you delete it there:
do that after the new one is accepted.

**The webhook secret:** set the new secret in the App's settings on GitHub and in Stackport (same dialog). Stackport cannot check it, so a mismatch shows as
deliveries refused with 401 (GitHub's *Recent Deliveries* tab on the App shows them). Use a value of at least 16 characters.

**The encryption key (`ENCRYPTION_KEY`):** the App's three secrets are on the re-encryption list, so Settings > Encryption > Re-encrypt moves them with the
rest. Rotate that key as described in [../1.3/security.md](../1.3/security.md) (S7); the App needs no extra step, and `tests/githubAppHardening.test.ts` rotates them and signs with the result.

## When the domain changes

GitHub cannot edit a manifest-registered App's addresses from Stackport. Settings > GitHub shows **"registered for X, but this server is now at Y"**. In the
App's settings on GitHub, change the webhook URL, the callback URL and the setup URL to the new domain. Stackport never registers a second App on its own.

## Restoring on another host

The App's identity (id, private key, webhook secret) is in the database, encrypted. A restore needs the database **and** the `ENCRYPTION_KEY` (and any
`ENCRYPTION_KEY_PREVIOUS`) it was written with; without the key the secrets cannot be read and the App has to be forgotten and registered again. After the restore, check the
domain (above). Installations, repositories and the delivery log come with the database.

## Rolling back Stackport

`stackport rollback` runs the previous release on the migrated database. Migration 016 only adds tables and nullable columns
(`tests/githubAppHardening.test.ts` checks that older code still runs on it). The previous release does not know the App: projects bound to it have no token it can use
until you move them back, and the webhook address answers 404 (it reads `app` as a project id). **Move App projects back to a token first** if you expect to roll back.

## When something is wrong

| Symptom | Look at |
|---|---|
| Pushes do not deploy | Settings > GitHub > Recent deliveries: the result column says why (not linked, no access, wrong branch, paused, manual, no project bound). GitHub's *Recent Deliveries* on the App shows what it sent and what we answered |
| Deliveries refused with 401 | The webhook secret differs between GitHub and Stackport (rotate it) |
| A project's deploy says the App no longer has access | Add the repository to the installation on GitHub, **Refresh**; or move the project back to its token |
| "No connected installation can use owner/name" | Install the App on that owner and **Connect an account** |
| A delivery shows `failed` | It is retried at start-up up to three times; fix the cause, then **Replay** |

## What is stored, and for how long

- Credentials: encrypted in SQLite; never returned by the API, logged, audited or written to a delivery.
- Installation tokens: memory only, refreshed a minute before they expire.
- Deliveries: a reduced copy (the fields Stackport uses; never the raw body or anything else in it), handled deliveries for 14 days, failed ones for 30.
- A webhook body over 5 MB is refused with 413 before it is read in full.

## From an MCP client

`stackport_list_github_repositories` lists what the App can use and which repositories are projects already.
`stackport_create_project_from_repository` is two-step like the other write tools: the first call describes what would be created
(and repeats that anyone who can push to the repository controls what runs), the second, with the confirmation id for exactly
those arguments, creates it. A token limited to a project group creates the project inside that group and cannot choose another.
It does not deploy anything.

## What was and was not verified

Everything above is tested against an in-process fake of GitHub (`tests/helpers/fakeGithub.ts`): the manifest round trip, the OAuth exchange, JWTs checked with
the App's public key, installation tokens, repositories, branches and trees, rate limiting, signed deliveries. **It has not been run against github.com.** What
only a real account can confirm: GitHub accepts this manifest (the first real registration, in 1.3.8, was refused because the manifest named the `installation` and `installation_repositories` events, which GitHub sends to every App on its own; they were removed in 1.3.9. The permission and event pairs for the optional modules are still unconfirmed), the redirect and callback addresses, the exact shape of the conversion and installation responses,
and that a real clone with an installation token works with `x-access-token` as the user name.
