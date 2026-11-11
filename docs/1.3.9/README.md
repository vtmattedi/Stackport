# Stackport 1.3.9

Started 11 November 2026, from 1.3.8.

## Decided

- **The version a server shows is the version that shipped.** `package.json` (and the six other files that record it) is raised in
  the branch, and a new check on pull requests to `main` ([version-gate.yml](../../.github/workflows/version-gate.yml),
  [version-gate.sh](../../scripts/ci/version-gate.sh)) refuses a version that is not higher than main's, or one that differs from a branch
  named like a version. 1.3.7 ran as `v1.3.1` because nothing checked this.
- **The temporary Migrations page is gone.** Removed: the managed-volume copy (S2), the removal of the original mounts, and the env-value
  encryption (S13). Kept, and renamed Settings > Encryption: re-encrypting the stored secrets, because it is how an encryption key (or
  `JWT_SECRET`) is rotated. **Consequence:** a project that was created before 1.3 and still has managed volumes off can no longer be
  switched over from the UI. It keeps its current mounts. Check Settings > Project protections before updating a server that still has such
  a project, and migrate it on 1.3.8 first.

## To plan

See [ui-pass.md](ui-pass.md): the Settings and Host pages, and where host reboot and Docker network management belong.
