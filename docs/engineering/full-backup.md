# Full backup and restore from the dashboard

Settings > Backup. One encrypted file holds an instance's settings and secrets (level 1) and **every project with its data** (level 3); another Stackport restores it, becoming a copy of the first. (For one project moved while the source is stopped, see [peer-control.md](peer-control.md).)

## The file

An `.spbackup` (the same sealed container as every other archive) whose first entry is `full.json` and whose other entries are sealed archives made with the same passphrase: `parts/instance.spbackup` (a level-1 archive, checked exactly as `stackport restore` checks one) and `parts/project-<id>.spbackup` (a level-3 archive each, with its own digest). `full.json` records each part's size and SHA-256, whether the project was running, and how it reached GitHub (credential and App binding by id: the instance part carries both under the same ids).

## Making it (`src/modules/backup/fullBackup.ts`)

A job on the instance being copied. Projects are copied **one at a time**: the project's action slot is taken (nothing deploys, restarts or deletes it meanwhile), automation is paused, it is stopped if it ran, its archive is made with volumes verified by the helper, and it is given back as recorded (started if it ran, paused flag restored). The projects stopped are written to `full_backups.quiesced_json` before they are touched, so a restart in the middle gives them back (`reconcileFullBackups`, run by the peer monitor's tick). A failure gives back everything stopped and fails the job. The file is kept 24 hours in `data/backups/`; download and delete are Settings > Backup's buttons. The passphrase is held in memory for the job only. Needs Docker (the helper).

The temporary pause is cleared before starting a project, and its original pause flag is restored afterwards, including when start fails. The job waits for recovery before moving to the next project or sealing the file. A failed recovery stops the backup and keeps its recovery record for the monitor to retry under the project's action slot; a new backup and deletion of that record are refused until recovery succeeds.

## Restoring it (`src/modules/backup/fullRestore.ts`)

1. **Upload and inspect.** One streamed request (no resume; a restore that is cut short starts again). Opening the file checks `full.json`, every part against its recorded size and SHA-256, and the instance part with the restore's own verification. Nothing is changed; the preview lists the projects and what will be replaced.
2. **Replace the instance.** The admin types this instance's name and the passphrase. The same `stackport restore` an operator runs is started on the host in a detached container, as the dashboard's update is (`updaterRunArgs`, chroot into the host), because it stops this app, replaces its database and adopts the archive's keys into the host's `secrets.env`. The passphrase reaches it in a file (`STACKPORT_BACKUP_PASSPHRASE_FILE`, mode 600) that the script reads once and removes: it is never an argument or an environment value visible in `docker inspect`. A plan of the projects is written first, in the data directory, outside what the restore replaces.
3. **Bring the projects back.** The restarted instance (now the restored one) shows the pending plan; the admin gives the passphrase again (it is never kept) and each project is imported with the project-archive verification (re-read and recomputed digest, undone on a mismatch), keeps its hostnames, compose service and port, its branch and commit, its credential and App binding where the instance part has them, and is started if it was running (recover) or left paused (clone). A hostname that served TLS gets a certificate request once the projects are back; a failure is told and leaves HTTP. A failed project keeps its part, so it can be tried again.

Verified imports and completed projects are checkpointed in the restore plan. A failed start leaves the imported project paused and its archive available; retry starts that same project without importing its data again. A failed nginx apply is reported as a failed restore and can be retried without redeploying completed projects. A missing archive without an import checkpoint is an error, never evidence of a successful restore.

## Uploads

Stackport's own nginx route streams `PUT /api/backup/restore/upload` directly to the authenticated API, with request buffering off, a 200 GiB size limit matching the API, and one-hour idle timeouts. Archive inspection also has a one-hour response timeout. These settings also apply to bootstrap HTTPS and do not enlarge managed applications' or other API endpoints' body limits. The sealed upload is kept until completion or cancellation so the preview can be verified again after a page reload. Update the destination before uploading so its generated nginx configuration includes these locations. A proxy outside Stackport can impose a smaller limit and must be configured separately.

## Limits

Certificates, containers and images, deploy history, logs and TCP exposures are not carried (the preview says so). The restore replaces the instance: the previous database and secrets are kept on the host under `backups/pre-restore-…`. The restore needs the host CLI to understand `STACKPORT_BACKUP_PASSPHRASE_FILE`, so the host's `stackport` must be updated before restoring from the dashboard; the dashboard's own update does that.

## Verification

`tests/fullBackup.test.ts` exercises the source pause/start guard, delayed and failed recovery, a real offline database restore into a separate destination, secret decryption, and retry after project start or routing failure. Docker and deployment effects are replaced in that test.

`npm run test:backup:docker` checks the generated configuration through real nginx (a 2 MiB upload, ordinary-route limits, and an over-limit declaration), then exports and imports a real Docker named volume, checking its data, tree digest, ownership and mode. It uses disposable containers, networks and volumes, publishes no host ports, and requires the locally available images `stackport:ci` and `nginx:1.30.7-alpine`. It does not exercise the detached host CLI/chroot, public DNS/TLS issuance, or a full migration between two VPSs; those still need staging verification.
