# Compatibility evidence and boundaries

Automated tests use separately copied/downloaded resources, disposable profiles, synthetic notes, and a loopback server. The installed app is not patched. No proprietary client bundle or sandbox profile is shipped.

## Client builds

| Build | app.js SHA-256 | Adapter |
| --- | --- | --- |
| Desktop 1.8.7 | `fc1b1bede214e0f28266ce356b43c2aa36329a3b3cb47160f3a086110a03c9b5` | Original native connector through the allowed loopback hostname |
| Desktop 1.15.1 | `31c39502ad7ca49b003ea3fb2fef5889b00160c0290e548e3cc5c6506b8c4d31` | Independent in-memory connection bootstrap, followed by unchanged native handlers and transfer methods |

The current bundle was downloaded from the official release and checked against its GitHub asset digest. Both bundles were exercised as full applications in a separate Electron 43.1.1 macOS test runtime. These results qualify those copied app bundles and the tested adapters; they do not establish the complete standalone installers on every OS or every Electron patch release.

## Important discoveries

The app replaces public `webRequest` registration functions with no-ops. An ordinary hook call can silently do nothing. The implemented adapter instead uses Electron's Fetch interception and leaves the application's existing app-origin/response protections installed.

Desktop 1.15.1 rejects loopback in its original connector and opens Settings in another window. The plugin therefore supplies only its connection bootstrap for that build and coordinates account interception across the session's app/Settings windows. Encryption, transfer methods, revision processing, indexing, and merging remain native.

## Verification layers

- `feasibility.json`: two complete 1.8.7 sandbox clients passed native login, remote-vault selection/unlock, and encrypted note transfer through the embedded relay against the research fixture.
- `native-contracts-1.8.7.json`: 18 checks across encryption versions 0, 2, and 3 against the Go server over real sockets. The Node harness dispatches each WebSocket message as a browser task so the old native transport can install binary waiters; it does not emulate the Sync protocol or encryption.
- `crash-recovery.json`: separate Go subprocesses verified acknowledged ciphertext survival after SIGKILL, rejection of incomplete uploads, temporary-file cleanup, persistent sessions, and offline backup/restore into a fresh server.
- `full-app.json`: full-engine cross-version test outcomes, including current default encryption version 3.
- Go tests cover native HTTP fields and error envelopes, token revocation, immutable multipart revisions, history/deletion/restore, replay beyond queue capacity, cross-vault isolation, storage limits, commit failure, recovery, backup locking, and restore.
- Plugin tests cover account-only routing, unsupported-operation blocking, Settings-window coordination, same-server references, conflicting-server rejection, external-debugger ownership, relay framing/capability checks, and reversible bootstrap installation.

The GitHub workflow runs Go's race detector and static analysis on Linux amd64, plugin tests, and both Linux cross-builds. Check its actual run status in GitHub Actions; arm64 execution requires an arm64 host and is not implied by cross-compilation.

## User-confirmed iPhone tests — 17 November 2026

After installing the 0.1.2 test build, the owner confirmed phone↔desktop note synchronization, offline convergence, synchronization resuming after closing/reopening Obsidian, and an attachment larger than 2 MiB. Their confirmation of the full checklist also covers an empty note, rename/delete, history and restore. See the [device test record](ios-device-tests.json) and [current mobile status](MOBILE-STATUS.md).

This is user-reported manual evidence. No new device fingerprint, model/OS details, logs or network destination capture were supplied. Core iPhone flows are user-confirmed; this does not establish full device qualification, every conflict/recovery scenario, or Android/Windows/Linux desktop support. Historical build-time reports retain their original scope.

## Development harness

`tools/native-contracts.cjs` requires:

```sh
OBSIDIAN_TEST_ASAR=/absolute/path/to/sandbox/obsidian.asar \
SYNC_TEST_SERVER=http://127.0.0.1:8080 \
SYNC_TEST_PASSWORD=disposable-owner-password \
SYNC_TEST_REPORT=/absolute/path/to/report.json \
node tools/native-contracts.cjs
```

The test owner email is `bridge@local.invalid`; initialize an isolated server accordingly. Supply a new test database or enough vault slots. The harness refuses a real installed app path.

`tools/sandbox-runner.cjs` is a private full-app integration entrypoint to run with a separate compatible Electron executable. It requires `SYNC_TEST_SANDBOX` (an initially empty scratch directory), `OBSIDIAN_TEST_ASAR` and `SYNC_TEST_BOOTSTRAP_ASAR` pointing to copied app/bootstrap archives, `SYNC_TEST_SERVER` on loopback, and a `SYNC_TEST_PROFILE` label. It creates only marked disposable vault/profile directories and a private file-based command channel. Never use it with real credentials or real vaults. The ordinary plugin build/test commands do not launch any app.

`tools/crash-recovery.cjs` takes an absolute `SYNC_TEST_BINARY` and optional `SYNC_TEST_TMPDIR`/`SYNC_TEST_REPORT`. It generates its own account and data, launches only that server executable, and never opens Obsidian.

## Remaining limits

- iOS 1.15.1 has an experimental adapter with user-confirmed core device flows; broader qualification remains incomplete. Android remains diagnostic only.
- No official/custom account coexistence within one profile.
- Developer Tools or another debugger can detach interception; the plugin reports failure and requires reactivation. Routing cannot exist before the plugin loads or while it is disabled.
- No automatic history pruning, permanent purge, sharing, migration, or server-managed encryption.
- The owner reports successful phone synchronization through their setup; exact server deployment, TLS/reverse-proxy configuration and storage filesystem were not independently inspected.
- Simulated write/commit failures and process crashes are tested; physical power-loss and every possible conflict scenario are not proven.
- Community-directory acceptance is external to the code/release and remains a separate publication step.
