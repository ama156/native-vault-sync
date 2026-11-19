Server 0.2.0 adds per-user sessions, administrator-managed co-owner membership and equal quota allocation while preserving these wire shapes. See [multi-user contracts](MULTIUSER.md) and [security](SECURITY.md).

# Native protocol contract

For full request/response examples, see the [API reference](API-REFERENCE.md) and [OpenAPI document](HTTP-API.openapi.json). The [technical deep dive](TECHNICAL-DEEP-DIVE.md) explains the client internals and separates observations from independent implementation choices.

The server implements an independently recovered private client contract. JSON field shapes and error handling are compatibility behavior; database layout is an independent design.

## Account API

All routes below accept JSON POSTs. Account failures contain an `error` string. Tokens are bearer credentials carried in JSON, not cookies. The server does not redirect account requests elsewhere.

| Route | Input | Successful output |
| --- | --- | --- |
| `/user/signin` | `email`, `password`, optional empty `mfa` | `token`, `email`, `name`, `license` |
| `/user/info` | `token` | `email`, `name`, `license` |
| `/user/signout` | `token` | `res: "ok"`; session revoked |
| `/subscription/list` | `token` | `sync: true`; describes this private service's capability |
| `/vault/list` | `token`, client capability hint | `vaults`, `shared: []`, vault-count `limit` |
| `/vault/regions` | `token`, optional `host` | `regions: [{value: "self-hosted", name: "Self-hosted"}]` |
| `/vault/create` | `token`, `name`, `salt`, `keyhash`, `encryption_version`, optional `region` | Vault metadata |
| `/vault/access` | `token`, `vault_uid`, `keyhash`, `host`, `encryption_version` | `res: "ok"` after key/version/host checks |
| `/vault/rename` | `token`, `vault_uid`, `name` | `res: "ok"` |
| `/vault/delete` | `token`, `vault_uid` | `res: "ok"`; vault made inaccessible |

Vault metadata contains `id`, `name`, `host`, `salt`, `encryption_version`, `region`, `size`, and `created`. The host is the configured public authority plus `/sync`, without a scheme. Encryption identity is fixed at vault creation, never pinned by the first socket connection. Standard/server-managed encryption is unsupported.

In this initial release, remote-vault deletion is a soft deletion: it disconnects clients and removes the vault from discovery, while retaining ciphertext/history and its storage accounting. There is no permanent-purge endpoint. File deletion uses revision tombstones and remains restorable. This retention policy deliberately prevents accidental data reclamation.

`GET /healthz` identifies the service and bridge protocol version and reports readiness. It reveals no account or vault metadata. `/sync` is a WebSocket upgrade endpoint. Unknown account operations, MFA, official sharing/invitation/migration APIs, password-recovery mail, and public registration are unsupported.

## WebSocket

1. Client sends `init` with `token`, vault `id`, `keyhash`, `version`, `initial`, `device`, and `encryption_version`.
2. Server validates account session, vault, encryption identity/version, and cursor. It replies `res: "ok"`, `userId: 1`, and `perFileMax`.
3. Initial connections receive latest nondeleted records; reconnects receive revisions newer than the cursor. The server holds a revision-order barrier across replay and live subscription.
4. Server sends `op: "ready"` with the corresponding per-vault revision watermark. Live pushes follow in commit order.

Ordinary requests are serialized by the native client; there are no request-ID fields to invent. Notifications use `op`; replies use `res`. A single server writer sends complete download batches so live pushes cannot interrupt binary reconstruction.

### Operations

- `push`: opaque `path`, optional `relatedpath`, exposed `extension`, opaque `hash`, timestamps, `folder`, `deleted`, and, for files, ciphertext `size` and `pieces`.
- Immediate `res: "ok"` means no binary data is required. Otherwise `res: "upload"` requests data; each binary message receives an acknowledgment. Final acknowledgment and push notification occur only after durable blob installation and database commit.
- Each binary message is at most **2,097,152 bytes**; `pieces = ceil(ciphertext size / 2097152)`. Empty files have no pieces. Folders/deletions omit file data.
- Native `perFileMax` applies to plaintext size. The server allows the extra 28 bytes used by the inspected providers' nonempty GCM output. Quotas count stored ciphertext.
- `pull {uid}` returns that immutable revision's size/piece metadata and ordered binary messages. Deleted revisions return `deleted: true` with no content.
- `history {path,last}` returns up to 100 newest-first records and a `more` flag. A positive `last` requests earlier revision IDs.
- `deleted {suppressrenames:true}` returns latest tombstones, suppressing records with a rename relationship.
- `restore {uid}` creates a new revision referring to the selected historical ciphertext. The native client applies it normally.
- `size` returns retained ciphertext `size`, account `limit`, and current `vault_size`.
- `usernames` returns the owner label keyed by user ID.
- `ping` receives application-level `pong`. Protocol-level WebSocket control frames are handled separately.
- `purge` returns an explicit unsupported error.

Session authorization is checked on incoming authenticated messages and before revision commit. Revoked sessions are also excluded from subsequent broadcasts. New tokens default to 30-day expiry (configurable); migration preserves existing expiry times. A cursor newer than the server's history is rejected with a reconnect instruction.

## Storage and recovery

SQLite metadata uses WAL and full synchronization. Uploads stream into private temporary files. Complete files are synchronized and installed under ciphertext SHA-256 names before their references are committed. Unreferenced files from failed commits and abandoned temporary uploads are removed during startup; missing referenced ciphertext prevents readiness.

History bytes are immutable, including across restore. The server never sees plaintext paths, note content, vault passwords, or raw encryption keys. Account and vault names, device labels, extensions, sizes, timing, and change relationships remain visible metadata.

Offline backup takes the same exclusive data lock as the service and creates a consistent SQLite snapshot with `VACUUM INTO`. Restore extracts only a new destination, rejects unsafe archive entries, validates SQLite integrity and ciphertext checksums, and refuses to overwrite an existing configuration or data directory.
