# Security and validation review — 0.2.0

Reviewed on 2026-11-19. This is an implementation review and automated acceptance record, not an independent penetration test. Use [deployment controls](SECURITY.md) and the [upgrade procedure](MULTIUSER.md) alongside it.

## Boundaries checked

| Boundary | Implementation and evidence |
| --- | --- |
| Public API → account | Random bearer tokens are hashed in SQLite. Enabled account and original expiry are checked on each authenticated operation. Password reset/disable revoke sessions. Missing users run Argon2; errors remain generic. |
| Account → vault | Membership gates HTTP and WebSocket initialization, revisions, history, restore and downloads. Queries bind both vault and revision identifiers. Only Unix administration changes membership; public co-owner selectors keep `shared: []`. |
| Revocation → active transfers | Writers check authorization under the policy read lock before metadata/binary writes. Administration takes the write lock and disconnects unauthorized sockets. Tests interrupt uploads after a first acknowledged piece for membership revoke, password reset and disable; no unfinished revision becomes visible. |
| Upload → storage | Bounded pieces stream to private temporary files. Pending capacity is reserved for all members; commit rechecks allocation and current file allowance. Durable immutable files precede SQLite commit. Final acknowledgments follow commit. Tests cover concurrent reservations, quota reductions and recovery from failed commits. |
| Proxy → client address | Forwarded addresses are accepted only from configured CIDRs. The Nginx example replaces incoming forwarding headers. Tests check untrusted peers and spoofed forwarding values. |
| Administrator → daemon | Mode-0600 Unix socket inside a private data directory; no TCP administrative endpoint. Offline commands require the exclusive service lock. Credentials are accepted through hidden prompts, stdin or files, never required as environment values. |
| Archive → fresh installation | ZIP/directory/tar restoration validates paths, regular files, checksums where available, SQLite integrity and referenced blobs. Tests reject corruption, missing blobs and traversal entries. The original manifest-free tar format remains accepted. |

Quota charging includes retained ciphertext history and soft-deleted vaults. It excludes database/filesystem overhead and the independent pre-upgrade snapshot; monitor disk space separately. The administrator is trusted, and a co-owner deliberately has vault-wide read/write/rename/delete authority. Already delivered data cannot be revoked remotely.

The server stores ciphertext, encrypted paths and opaque client hashes. Vault display names, account metadata, membership, sizes, extensions and timing are server-visible. Backups contain account hashes/session hashes and should be private even though note contents remain encrypted. Log review found no intentional credential, note-body or encryption-key logging; the proxy format omits query strings.

## Dependency review

`govulncheck` v1.10.0 scanned both server packages and their imported code with Go 1.27.4. After updating `golang.org/x/crypto` to v0.59.0, `x/term` to v0.48.0 and `x/sys` to v0.50.0, the final scan reported **no vulnerabilities** at symbol, package or required-module scope. The prior crypto version had advisories in unused SSH/OpenPGP packages; the update removed those scan findings. Dependency identities and hashes are pinned in `server/go.mod` and `server/go.sum`.

JavaScript audit results and Linux deployment results are recorded in the [release validation record](VALIDATION-0.2.0.json). Scanner databases describe known published issues at scan time; clean results do not prove absence of unknown flaws. Docker builds pin the builder image digest, compile a static binary and ship a scratch runtime with certificate roots. No registry image is published by this release.

## Compatibility evidence

- [Desktop native transport](native-multiuser-0.2.0.json): 18 contract checks across encryption versions 0/2/3 using copied 1.8.7 resources and a real loopback listener.
- [iOS native engine](ios-multiuser-0.2.0.json): 13 checks including two-account co-ownership, native filtering, encryption, >2 MiB attachments, replay and revocation using privately supplied 1.15.1 source in an isolated VM.
- [Crash recovery](crash-recovery-0.2.0.json): real SIGKILL, acknowledged ciphertext/session persistence, unfinished-upload cleanup and fresh restoration.
- [Restic round trip](restic-acceptance-0.2.0.json): actual local restic repository, repeated snapshots, repository verification and restoration into a fresh server.

No installed Obsidian application, main profile or real vault was launched or modified. These source-harness results do not independently qualify a new real iPhone build, Android, Windows or continuous mobile background execution. The plugin's platform adapters are unchanged for 0.2.0.

High availability, public signup, MFA, SSO, email recovery, automatic history pruning and distributed limiters remain outside this release. Operators control scheduling, retention, TLS renewal, firewall policy and deployment monitoring.
