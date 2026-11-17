# One plugin: desktop adapter and experimental iOS adapter — 0.1.2

**iPhone note sync, offline convergence and close/reopen resumption are user-confirmed. Attachment syncing is reported failing in both directions and is under investigation (17 November 2026).** Version 0.1.2 contains an opt-in iOS 1.15.1 adapter with custom login, remote-vault selection and direct WebSocket synchronization. Version 0.1.1 was diagnostic only. Android remains diagnostic only.

Use the [0.1.2 test release](https://github.com/ama156/native-vault-sync/releases/tag/0.1.2). Upgrade the server to 0.1.2 first. No community-directory submission is being made.

## Before installing

This adapter requires **iOS Obsidian 1.15.1 with the inspected method fingerprints**, an unused native account instance, and a disposable local vault with no other remote Sync connection. It refuses existing accounts and saved signed-out accounts. A second vault does not isolate Obsidian's global account state.

**Do not sign out or reset your everyday phone account just to try this build.** If your phone already uses an account, use a clean dedicated test device/app environment. This project does not provide a supported second iOS app installation. Installing the plugin to collect its compatibility report is possible without activation; actual account integration needs that clean environment.

On desktop, create a disposable end-to-end encrypted remote vault on your custom server first. The initial iOS UI selects existing remote vaults; creating, renaming or deleting remote vaults remains a desktop operation. Do not use important notes for device qualification.

## Upgrade the Linux server

Download the matching `vault-sync-server_0.1.2_linux_amd64.tar.gz` or `arm64` archive and verify `SHA256SUMS`. Keep your existing configuration and data directory. For the binary/systemd installation:

```sh
sudo systemctl stop vault-sync
sudo -u vault-sync vault-sync-server backup \
  --config /etc/vault-sync/config.json \
  --output /var/lib/vault-sync/pre-ios-0.1.2.tar.gz
# After unpacking the matching archive in your working directory:
sudo install -m 0755 vault-sync-server /usr/local/bin/vault-sync-server
sudo systemctl start vault-sync
curl https://YOUR-SERVER/healthz
```

Health must report `version: "0.1.2"`, `bridge_protocol: 1` and `ready: true`. No database migration or reinitialization is needed. Keep the existing HTTPS/WebSocket reverse-proxy configuration. Version 0.1.2 adds the exact `capacitor://localhost` Origin to both HTTP/preflight and WebSocket validation; tokens, vault access, keyhash and encryption-version checks still apply. It does not broadly enable Android/browser origins.

## Install on iPhone

There is one plugin ID, `vault-sync-bridge`, and one `main.js` / `manifest.json` pair for every platform.

For convenient test installation, use [BRAT](https://github.com/TfTHacker/obsidian42-brat), which installs GitHub test releases without submitting this plugin to the community directory:

1. In the **clean test environment**, install and enable BRAT from Community plugins.
2. Use BRAT's **Add a beta plugin for testing** command/settings. Enter `ama156/native-vault-sync` and select/freeze version **0.1.2**. The [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md) documents specific-release and prerelease installation.
3. Enable **Vault Sync Bridge** in Community plugins. Confirm its displayed version is **0.1.2**.

Alternatively, disable the bridge and copy `main.js` and `manifest.json` from that release into the disposable vault's configured plugin directory, normally `.obsidian/plugins/vault-sync-bridge/`, then enable it. iOS Files may hide dot directories; use a trusted vault file-access method. Copy only the plugin assets, never an existing app/account database. Neither route requires changing `/Applications/Obsidian.app`.

BRAT contacts GitHub to download assets. Once loaded, this plugin sends its own account and Sync operations to the configured custom server. Directory publication remains deferred.

## Configure the iOS test

1. Enable the **Sync core plugin**, and open **Vault Sync Bridge** settings in the disposable vault.
2. Enter your server's HTTPS origin, such as `https://sync.example.com`, then choose **Test server**.
3. Enter the **custom-server** account email/password and choose **Sign in to custom server**. Do not use native account settings or official credentials. The adapter checks for a fresh native account before sending these credentials.
4. Choose the previously created remote vault, enter its encryption password, and choose **Unlock and connect**. Account and vault passwords are not saved by the bridge. Native Sync derives the encryption key and performs file reconciliation.
5. Check the native Sync status/log. Exchange a disposable note with the desktop, then test an empty note and an attachment larger than 2 MiB in both directions.
6. Fully close/reopen the test app, then test airplane-mode edits and foreground/resume. The owner has confirmed close/reopen resumption and offline convergence; broader background/suspension behavior still needs separate checks.

An unused test installation may have a saved, completely empty signed-out account record. The optional **Prepare empty account record** button removes only a record with the exact allowed empty fields; then fully quit and reopen the test app. It refuses accounts, licenses, unknown fields and remote-vault connections. It never signs out an existing account. If any safeguard refuses activation, stop and share the redacted compatibility report; do not paste tokens, passwords, raw storage or source bundles.

To disable, use **Sign out / disable**, or disable the plugin. Custom connections close and native Sync is paused. Local notes and the native index/history state remain. Sign-out revokes the custom server session. Plugin unload preserves its device secret for resumption when reenabled. An expired/revoked session requires signing out in bridge settings and signing in again.

## How the adapter works

The original iOS bundle captures its account object and `fetch` inside a private closure. Changing global `fetch` or writing localStorage after startup cannot update that object. Our source inspection is recorded in [the earlier investigation](IOS-SOURCE-INVESTIGATION.md).

For the exact inspected version only, the adapter invokes the fingerprinted native connection-acquisition method with an inert receiver. A temporary, nonenumerable getter on `Object.prototype.token` captures the fresh account receiver at its account-presence check. It returns `undefined`, so that call exits before transport creation. The getter exists only for one synchronous call and is removed in `finally` **before any await or event-loop turn**. A preexisting prototype property, unexpected receiver, populated account or fingerprint mismatch refuses activation. The live file-engine instance is not used as that probe receiver.

After successful custom-server login, per-instance account overrides expose a **local nonserializable session handle** to native presence checks. It is not a bearer token. JSON serialization and string coercion throw before captured native account helpers can issue a request with it. Native account refresh/logout delegate to the custom session; unsupported native login/license operations are blocked. The real server token stays inside the portable session client and is saved through Obsidian's device-local secret storage, bound to server origin and app/vault identity; it is not written to plugin `data.json` or native account storage. The owner reports session resumption after closing/reopening the app. Secret-store internals and startup network destinations have not been independently instrumented on the device.

A per-instance accessor adapts each newly created native transport's connection bootstrap. It first checks `/vault/access`, then opens browser `WebSocket` directly to `wss://SERVER/sync`, using the real custom session and native keyhash/version. Native post-login message handlers, encryption, upload/download, history, replay and file-engine methods remain original. This project ships no copied proprietary engine code, local mobile relay or Node/Electron dependency on the mobile path.

Method replacements are tracked and restored on unload. Server/account switching is refused while a session exists. Foreground/focus events and a foreground refresh timer refresh authorization and request native replay. There is **no continuous iOS background-sync promise**. Temporary outages keep native changes queued; expiry pauses the custom connection.

This is a narrow adapter, not a whole-app network firewall. Use its setup screens; unrelated app services may still contact their own destinations. The isolated proof records no official account requests during the exercised custom flows. Complete startup/reconnect destination capture on the actual phone remains outstanding.

## Compatibility and evidence

| Platform/build | 0.1.2 behavior | Evidence / limit |
| --- | --- | --- |
| macOS desktop 1.8.7 / 1.15.1 | Existing routing/embedded relay adapter | Copied-app sandbox qualification and regression tests; no installed app used |
| Windows / Linux desktop 1.8.7 / 1.15.1 | Same desktop adapter selected | Unit/branch tests; full platform qualification pending |
| iOS 1.15.1, exact inspected methods | Opt-in experimental custom Sync adapter | Isolated original-engine proof plus user-confirmed note sync, offline convergence and app close/reopen; attachments reported failing in both directions; broader qualification pending |
| Other iOS versions | Inactive read-only diagnostic | No adapter advertised |
| Android | Inactive read-only diagnostic | No Android source/origin/device qualification yet |
| Unknown platform | Inactive diagnostic | Guarded loader |

The [isolated proof report](ios-sync-proof.json) covers ten checks: wrong vault password, custom account gating, direct transport login/ready, native encrypted Markdown transfer both ways, empty files and >2 MiB attachments, new-runtime secret restoration/replay, replacement transport reconnect, revocation, and custom-only exercised destinations/native-account-storage isolation. It uses the original supplied file engine with synthetic vault/secret adapters and Node-backed development scrypt/WebSocket facilities. It is **not a run of the complete iPhone app** or proof of WebView crypto/networking, device keychain persistence, native filesystem/database restoration, UI lifecycle or background execution.

Build/unit checks cover 23 cases across account capture/refusal, serialization guard, origin-bound sessions, cancellation, cleanup, secure-storage failure, browser-only loading, redacted diagnostics and the existing desktop relay/routing. Server tests exercise exact iOS Origin matching and retain authorization checks. See [validation record](ios-adapter-tests.json).

**Corrected device results — 17 November 2026:** The owner reports successful phone↔desktop note sync, offline-edit convergence and resumption after closing/reopening Obsidian. They subsequently withdrew the attachment-success report: ZIP, EPUB, PDF and PNG attachments, both below and above 2 MB, fail to appear on the other device in either direction. The note/link arrives, but the attachment cannot be found. Attachment qualification is therefore **failed/unresolved**, not passed. Selective-sync settings, excluded folders and transfer behavior are being investigated. Other checklist results remain user-reported. See the [corrected device test record](ios-device-tests.json). No new device diagnostics or logs have been supplied.

Still unverified on device: simultaneous conflicting edits, Canvas/folders/settings, plugin disable/reload cleanup, broader suspension/background/resume behavior, expiry/revocation/reauthentication, outage/interrupted-transfer recovery and startup/reconnect destination capture. Device model and iOS version were not provided. Android, Windows and Linux desktop retain their separate qualification limits. The build-time [validation record](ios-adapter-tests.json) and [source proof](ios-sync-proof.json) are historical records; their pending-device statements describe the state before this owner report.

## Reproduce the private source proof

Supply the legally obtained iOS bundle privately; its expected SHA-256 is `ffd620f9ee985cc4eb93ab25ba5871a33c9460b68035f2d74c8d4ddc2d43ef91`. Neither it nor extracted source bodies belong in releases or commits.

```sh
cd server
go build -o /tmp/vault-sync-ios-proof ./cmd/vault-sync-server
cd ..
OBSIDIAN_IOS_SOURCE=/absolute/private/path/app.js \
SYNC_TEST_BINARY=/tmp/vault-sync-ios-proof \
node tools/ios-sync-proof.cjs
```

The harness creates a disposable loopback server/data directory and isolated JS realms. It never launches Obsidian or accesses a real vault/account. The source is parsed and fingerprinted locally, not copied into the distributed plugin. This private proof is separate from public CI, where proprietary source is unavailable.
