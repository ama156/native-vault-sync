# Consistent backups, ZIP and restic — 0.2.0

Backups recover the Sync server, including users, password hashes, sessions, memberships, quota settings, revisions and encrypted blobs. They do not export readable Markdown: the server lacks vault decryption keys. Keep vault encryption passwords independently recoverable.

## Snapshot formats

```sh
vault-sync-server backup --format zip --output /backups/server.zip
vault-sync-server backup --format directory --output /backups/snapshot
vault-sync-server backup --output /backups/server.tar.gz
```

Add `--config /path/to/config.json` when not using the default. The service must be stopped. Output must be a new path outside the live data directory. Each new-format snapshot contains `config.json`, a consistent `metadata.sqlite`, `blobs/`, and `manifest.json` with version, sizes and SHA-256 checksums. ZIP stores ciphertext without wasting compression effort. Locks, Unix socket, abandoned uploads and migration-snapshot directories are excluded.

The command holds the service lock, uses SQLite `VACUUM INTO`, verifies snapshot integrity/referenced ciphertext, and publishes the completed output only after success. Interrupted preparation leaves no published final archive. ZIP/configuration/database metadata are not separately encrypted: protect them as private server backups. Restic adds repository encryption.

## Restore

```sh
vault-sync-server restore --archive /backups/server.zip \
  --config /fresh/config.json --data-dir /fresh/data
vault-sync-server restore --snapshot /backups/snapshot \
  --config /other/config.json --data-dir /other/data
```

`.tar.gz` archives, including legacy archives without a manifest, remain supported; `--archive -` accepts legacy tar/gzip on stdin. ZIP requires a seekable archive file. Destination data directory and config filename must not exist. Restore rejects unsafe paths/nonregular entries, duplicate entries, missing/corrupt files, invalid database structure and inconsistent referenced ciphertext. It validates the imported manifest before any schema migration and removes snapshot-only files from the resulting live data directory.

Restore first into a fresh staging installation. After rolling the server back to an older backup, clients with newer cursors must reconnect through native vault setup; the server rejects ahead-of-server cursors. Do not silently connect a stale backup under the production domain and assume every client will automatically roll back safely.

## Restic integration

Use the **unpacked directory snapshot**, not a ZIP/gzip stream. Stable ciphertext contents can be deduplicated across snapshots even though newly encrypted revisions generally do not compress or deduplicate against previous revisions.

```sh
restic backup /backups/snapshot --tag vault-sync
restic check --read-data
restic restore SNAPSHOT_ID --target /restore-staging
```

Select the recovered application snapshot directory within restic's restored path tree, then pass it to `vault-sync-server restore --snapshot`. Restic credentials/repository are external to the Go server. Initialize the repository separately and keep its password off the application image/configuration.

### Automated wrapper

`deploy/backup-restic.sh` supports `systemd`, `compose` and `docker` modes and runs on the Linux host as root. It calls the native binary as the service user or runs a one-off non-root container. It uses an exclusive job lock, stops an already-running service, prepares a directory snapshot, restarts the service **before uploading**, then invokes restic. Preparation failure still attempts restart. Restic failure retains the snapshot job for retry. An initially stopped service remains stopped.

```sh
sudo install -m 0755 deploy/backup-restic.sh /usr/local/libexec/vault-sync-backup
sudo install -m 0644 deploy/vault-sync-backup.service deploy/vault-sync-backup.timer /etc/systemd/system/
sudo install -m 0600 deploy/backup.env.example /etc/vault-sync/backup.env
```

Edit the environment file with your actual repository, password-file path and deployment mode. For native deployments, the backup unit also loads `/etc/vault-sync/runtime.env`, matching the main service. For Compose, use the same source directory, project name and `.env` as production; the wrapper mounts its staging root as `/backups`. For plain Docker, set the existing container name; the wrapper reuses its volumes and image. If you supplied additional plain-Docker runtime overrides, retain them in its saved config or provide matching settings to the backup operation—the wrapper does not copy arbitrary container environment secrets.

Test manually with `sudo systemctl start vault-sync-backup.service` and inspect the journal before optionally enabling the timer. Its example schedule is 03:00 in the server's local timezone, with up to ten minutes of randomized delay. The project does not enable it or run automatic retention/prune. Staging jobs are private; the parent needs traverse permission for the service/container UID. Budget disk for a complete local snapshot in addition to live data.

For manual Compose backups:

```sh
docker compose stop vault-sync
docker compose run --rm vault-sync backup --format zip --output /backups/server.zip
docker compose up -d --wait
```

The `/backups` volume persists separately; optionally bind it to an absolute host path through `VAULT_SYNC_BACKUP_MOUNT`. For unattended operations use the wrapper rather than a three-command sequence without failure cleanup.

## Evidence

Go integration tests cover format round trips, corruption rejection, schema migration and exclusive locking. [Actual restic acceptance](restic-acceptance-0.2.0.json) verifies a disposable repository, repeated backups, repository data checking, and restoration of two co-owner accounts with exact multipart ciphertext. Wrapper tests simulate successful upload, failed preparation and failed restic upload to verify restart ordering and staging retention. Real deployments still need their own offsite credentials/storage and a restore drill.
