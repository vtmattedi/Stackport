# Full backup and restore from the dashboard

Settings > Backup. One encrypted file holds an instance's settings and secrets (level 1) and **every project with its data** (level 3); another Stackport restores it, becoming a copy of the first. (For one project moved while the source is stopped, see [peer-control.md](peer-control.md).)

## The file

An `.spbackup` (the same sealed container as every other archive) whose first entry is `full.json` and whose other entries are sealed archives made with the same passphrase: `parts/instance.spbackup` (a level-1 archive, checked exactly as `stackport restore` checks one) and `parts/project-<id>.spbackup` (a level-3 archive each, with its own digest). `full.json` records each part's size and SHA-256, whether the project was running, and how it reached GitHub (credential and App binding by id: the instance part carries both under the same ids).

## Making it (`src/modules/backup/fullBackup.ts`)

A job on the instance being copied. Projects are copied **one at a time**: the project's action slot is taken (nothing deploys, restarts or deletes it meanwhile), automation is paused, it is stopped if it ran, its archive is made with volumes verified by the helper, and it is given back as recorded (started if it ran, paused flag restored). The projects stopped are written to `full_backups.quiesced_json` before they are touched, so a restart in the middle gives them back (`reconcileFullBackups`, run by the peer monitor's tick). A failure gives back everything stopped and fails the job. The file is kept 24 hours in `data/backups/`; download and delete are Settings > Backup's buttons. The passphrase is held in memory for the job only. Needs Docker (the helper).

## Restoring it (`src/modules/backup/fullRestore.ts`)

1. **Upload and inspect.** One streamed request (no resume; a restore that is cut short starts again). Opening the file checks `full.json`, every part against its recorded size and SHA-256, and the instance part with the restore's own verification. Nothing is changed; the preview lists the projects and what will be replaced.
2. **Replace the instance.** The admin types this instance's name and the passphrase. The same `stackport restore` an operator runs is started on the host in a detached container, as the dashboard's update is (`updaterRunArgs`, chroot into the host), because it stops this app, replaces its database and adopts the archive's keys into the host's `secrets.env`. The passphrase reaches it in a file (`STACKPORT_BACKUP_PASSPHRASE_FILE`, mode 600) that the script reads once and removes: it is never an argument or an environment value visible in `docker inspect`. A plan of the projects is written first, in the data directory, outside what the restore replaces.
3. **Bring the projects back.** The restarted instance (now the restored one) shows the pending plan; the admin gives the passphrase again (it is never kept) and each project is imported with the project-archive verification (re-read and recomputed digest, undone on a mismatch), keeps its hostnames, compose service and port, its branch and commit, its credential and App binding where the instance part has them, and is started if it was running (recover) or left paused (clone). A hostname that served TLS gets a certificate request once the projects are back; a failure is told and leaves HTTP. A failed project keeps its part, so it can be tried again.

## Limits

Certificates, containers and images, deploy history, logs and TCP exposures are not carried (the preview says so). The restore replaces the instance: the previous database and secrets are kept on the host under `backups/pre-restore-…`. The restore needs the host CLI to understand `STACKPORT_BACKUP_PASSPHRASE_FILE`, so the host's `stackport` must be updated before restoring from the dashboard; the dashboard's own update does that.
