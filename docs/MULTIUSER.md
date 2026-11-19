# Multi-user administration — server 0.2.0

The public native-client HTTP/WebSocket shapes are preserved. Authorization is now per user and vault, rather than one owner for the whole service. Existing desktop/iOS adapters keep their connection implementation; plugin 0.2.0 updates the release version without changing those adapters. Android remains diagnostic only.

## Upgrade an existing installation

1. Stop Sync and create a backup with your existing server binary. Copy it off the server and verify restoration in a disposable location. Keep that binary for rollback.
2. Verify that the data directory belongs to the service UID and has private mode `0700`; older manually prepared directories may need a permission adjustment while stopped. Install 0.2.0, retain the configuration/data volumes and start it. Do not initialize an existing installation again.
3. First exclusive open migrates schema 1 to 2 transactionally. Before migration it creates a checksum-verified `pre-multiuser-*` snapshot inside the data directory, containing the original SQLite schema, configuration and ciphertext. This requires enough additional local disk space. If capture/verification fails, migration stops.
4. The old owner becomes user 1; existing vaults belong to that user. Vault IDs, encryption identity, ciphertext, revision cursors and existing session expiry times are preserved. Existing revisions are attributed to user 1.
5. Existing password hashes remain valid and are upgraded to PHC format after successful authentication. New sessions default to 30 days; old sessions are not extended.

Downgrade by restoring the pre-upgrade backup with the old binary into a fresh installation. An old binary cannot read schema 2. The automatic pre-migration directory can also be recovered by copying its verified config/database/blobs into fresh paths for the old binary; opening it with the new binary will migrate it again. Do not overwrite a running installation or delete the automatic snapshot until your independent backup is verified.

## CLI management

Run as the service user, root, or inside the container. Public registration, public administration, email recovery and MFA are not implemented. The first account is created by `init`; use `users add` for subsequent accounts.

```sh
vault-sync-server users add --email alice@example.com --name Alice
vault-sync-server users list
vault-sync-server users disable --user alice@example.com
vault-sync-server users enable --user alice@example.com
vault-sync-server users password-reset --user alice@example.com
vault-sync-server users quota --user alice@example.com \
  --max-storage-bytes 21474836480 --max-vaults 20 --max-file-bytes 208666624
vault-sync-server users usage --user alice@example.com
vault-sync-server sessions list --user alice@example.com
vault-sync-server sessions revoke --user alice@example.com --id HASHED_SESSION_ID
```

Numeric user IDs can replace emails. Unspecified quota fields remain unchanged. Account deletion is intentionally unavailable: disable access without orphaning ciphertext/history. Disabling/resetting an account revokes its sessions; enabling does not restore old sessions. Legacy `password-reset` still targets user 1. Passwords use a hidden prompt, `--password-stdin`, or `--password-file`; never put passwords in command arguments. A password-file's single final line terminator is treated as input framing, as with stdin.

While serving, these commands use a Unix control socket under the private data directory, mode `0600`. Its parent directory must remain private. It is not a public HTTP endpoint. Offline commands acquire the service's exclusive lock before changing data. Socket paths longer than 100 bytes are rejected; use a short internal data path. Administrative events omit credentials and request bodies; service events go to its logs and offline CLI events to stderr.

## Co-owning existing or new vaults

Create an encrypted remote vault through native desktop Sync, or select one already created. The administrator then grants access:

```sh
vault-sync-server vaults list
vault-sync-server vaults list --user alice@example.com
vault-sync-server vaults grant --vault VAULT_ID --user alice@example.com
vault-sync-server vaults members --vault VAULT_ID
vault-sync-server vaults revoke --vault VAULT_ID --user alice@example.com
```

Each member is a co-owner. All can read/write/rename/delete files, view and restore the full retained history, rename the remote vault and delete the remote vault **for everyone**. Only the CLI administrator changes membership. The final co-owner cannot be removed; disable that account to stop access while preserving ownership/accounting.

The new member signs into their own account, selects the same remote vault, and supplies its existing encryption password. Distribute that password separately; the CLI/server never receives it. Access revocation stops subsequent server delivery but cannot erase copies or encryption keys already downloaded.

Co-owned vaults appear in `vaults`; `shared` stays empty for compatibility with the installed bridge selectors. Official invite/sharing APIs are not enabled. Vault usernames expose current members and historical contributors for that vault, not a server-wide user directory.

## Equal quota accounting

Stored ciphertext, including retained history and soft-deleted vaults, is divided equally among current members. A 12 GiB vault charges two members 6 GiB each or three members 4 GiB each. Integer-byte remainders are assigned in ascending user-ID order, so allocations sum exactly to stored ciphertext.

All members' allowances and the global ciphertext cap apply. Pending uploads reserve capacity before binary pieces arrive; new bytes are reconciled at commit. A user cannot bypass another co-owner's limit by uploading on their behalf. Global and per-uploader connection/upload limits also apply. Metadata/database overhead is not counted as ciphertext usage; monitor filesystem capacity separately.

Adding a member must fit that user's storage and accessible-vault limits. Revocation always remains possible, even if redistributing the charge leaves others over quota. Existing data remains readable; storage growth is rejected until allowances are adjusted. Lowering limits does not delete files. Disabling an account leaves its membership/allocated share in place until the administrator explicitly removes it.

Remote-vault deletion retains historical ciphertext and therefore does not reclaim quota. Permanent purge and automatic history pruning remain unsupported. See [backups](BACKUPS.md) for independent recovery copies and the older-server cursor restriction after a rollback.
