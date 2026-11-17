# Desktop and mobile diagnostic build — plugin 0.1.1

**iOS/Android custom synchronization is blocked at the account-integration milestone.** This build is one plugin asset with the existing desktop adapter and an inactive, read-only mobile diagnostic. It is not a working mobile Sync adapter.

The server remains 0.1.0; no server upgrade is needed to collect this report. No community-directory submission has been made or requested. Use a manually installed test build only.

## What is implemented

- One plugin ID, `vault-sync-bridge`, and the normal `main.js` / `manifest.json` release assets.
- Guarded loading: Electron main-process coordination stays in its own branch, desktop renderers use the existing desktop adapter, and iOS/Android use the browser-only diagnostic.
- A shared platform/version compatibility module. Unknown platforms take the inactive diagnostic path.
- An explicit build check that the mobile dependency graph compiles for a browser with only the Obsidian SDK external. Node/Electron imports in that graph fail the build.
- A mobile settings page and command, **Inspect mobile compatibility (read-only)**, that produce a redacted report only when requested.
- A selectable report with a clipboard action and a manual-copy fallback. Reports are not saved, logged or uploaded.

On mobile the plugin does not read its saved desktop activation settings, account storage, vault keys, host addresses, note names or note contents. It does not invoke native Sync setup, disconnect, resume, connection, indexing or file methods. It installs no account/session/transport overrides and initiates no HTTP or WebSocket requests. Existing native Sync may continue operating independently; this diagnostic is not a firewall or replacement for it.

## Compatibility matrix

| Platform/build | This release's behavior | Evidence |
| --- | --- | --- |
| macOS desktop 1.8.7 / 1.15.1 | Existing experimental routing/relay adapter | Earlier full-app copied-bundle sandbox cases; current unit/build checks |
| Windows / Linux desktop 1.8.7 / 1.15.1 | Same desktop adapter selected | Branch-selection tests; full-app platform qualification remains outstanding |
| Other desktop versions | Existing adapter rejects activation | Exact version allowlist |
| iOS 1.15.1 | Read-only diagnostic; custom Sync inactive | User's runtime screenshots, actual mobile source inspection, mocked source contracts, and simulated no-Node loading/report tests; no on-device run of this plugin yet |
| Android | Read-only diagnostic; custom Sync inactive | Simulated no-Node loading/report tests only; device/emulator qualification deferred |
| Unknown platform | Read-only diagnostic; custom Sync inactive | Conservative loader behavior |

`isDesktopOnly:false` permits diagnostic installation on mobile. It is not a claim that mobile synchronization is supported. A successful report also does not establish that an adapter can authenticate or transfer encrypted revisions.

## Why the first milestone is blocked

User-provided iPhone 1.15.1 inspections establish:

1. The native Sync instance and its transport are accessible and extensible. `getHost`, `setup`, and transport `connect` are writable/configurable; the engine's `server` property is configurable.
2. The transport's original connector enforces the official `.obsidian.md` hostname suffix. A direct custom connection would require an independent browser-WebSocket bootstrap.
3. Both `_sync()` and `asyncGetServer()` reference the module-scoped account token (`be.token` in that mobile bundle). Obtaining a custom token in plugin settings does not satisfy those captured checks.
4. The visible app object did not expose an obvious account/auth-named property. This is not proof that no reachable interface exists.
5. The official mobile WebSocket sent `Origin: capacitor://localhost`. Our current server does not yet allow it.

The actual iOS bundle was subsequently supplied and inspected privately. Its SHA-256 is `ffd620f9ee985cc4eb93ab25ba5871a33c9460b68035f2d74c8d4ddc2d43ef91`. Thirteen isolated, mocked source checks confirm the private account binding, captured fetch behavior and storage/refresh risks. The user's runtime fetch check did not establish a Capacitor HTTP interception route. No callable, reversible custom-session integration has been found; see the [iOS source investigation](IOS-SOURCE-INVESTIGATION.md) and [redacted contract report](ios-account-inspection.json). The older diagnostic test report records the state at the time that prerelease was built.

Following the agreed stop condition, this change does not implement mobile login, modify the native file engine, replace the account with a dummy/official token, write credentials into native account storage, or claim custom-session tests passed. It does not broaden server origins before there is a usable mobile adapter. Native `_sync()` remains unchanged.

## Install the diagnostic manually

1. Download the **0.1.1 mobile diagnostic prerelease**, not the 0.1.0 desktop-only ZIP. It contains `main.js`, `manifest.json` and this guide.
2. Unzip the plugin assets into the selected vault's configured plugin directory, normally `.obsidian/plugins/vault-sync-bridge/`. The two files must be directly in that directory, not in another nested ZIP folder.
3. On iOS, use a trusted file-access method for the actual vault, or stage the files in a disposable vault on another device and transfer that vault. The iOS Files UI may hide dot directories; this project does not promise a one-click iOS installer. Never copy an entire real profile/account database to obtain these two files.
4. Enable the already-installed **Vault Sync Bridge** under Settings → Community plugins. It will not appear in Browse because directory publication is deferred.
5. Open the bridge settings and choose **Inspect compatibility**, or run its read-only inspection command.
6. Copy the redacted JSON report and share it in this private chat. Do not sign out, call native `setup()`, replace the current remote vault, or enter real credentials for this diagnostic.

Merely collecting the report is read-only with respect to accounts and notes. Installing/enabling a community plugin necessarily changes the selected vault's plugin files and plugin enablement setting, which the vault's existing synchronization may propagate. For minimal disruption, prefer a disposable test vault; a separate vault does not isolate the app's global account session.

If the same plugin was already installed on desktop, normal desktop behavior is retained, including any saved enabled routing. This mobile diagnostic does not disable or overwrite desktop settings synced between devices. To remove it on mobile, disable it; it has no native overrides or connections to restore. Manual file installation/update should occur with the plugin disabled to avoid mixing old/new assets.

## Report format and privacy

Schema identifier: `vault-sync-bridge.mobile-diagnostics.v1`.

The report contains plugin/app version, platform classification, inactive routing status, browser WebSocket/WebCrypto capability flags, native instance availability, data-property descriptors, method source lengths, SHA-256 fingerprints where available, and whether those sources mention a token property or the official domain. It does not print function source, token values, passwords, raw keys, host URLs, vault IDs/paths, socket URLs or note data.

Function fingerprints identify inspected methods, not the complete bundle. Presence of `.token` in source is a structural clue, not a live account-state read or proof of a particular control-flow path. Getters are not invoked by descriptor inspection. The plugin calls the existing plugin-registry lookup only to locate the Sync instance, without enabling or configuring it.

The diagnostic is trusted plugin code running inside the app; read-only behavior is an implementation restriction verified by tests, not an OS-enforced privilege boundary. Sharing a report is a manual user action.

## Tests and what is not tested

The mobile tests cover platform/version selection, rejection of Node dependencies in a browser build, running the complete shared asset without `process`/Buffer/Node/Electron, prevention of account/file/network access, immutable native objects, source-value redaction, getter avoidance, missing transports/crypto, clipboard fallback and preservation of desktop/main-process loader branches. Existing relay/routing/bootstrap tests continue to run.

No real iPhone or Android custom login, cross-device transfer, app startup/reconnect, account refresh/expiry, background/resume, large attachment, history, restore or conflict test has passed for a mobile adapter. The screenshots show original native behavior against official infrastructure, not this diagnostic or the custom server.

## What is needed to resume implementation

The actual iOS `app.js` prerequisite is now complete; no further host/socket screenshots or diagnostic installation are needed to establish the same account checks. Do not send account storage or a raw network archive. The supplied proprietary source stays outside the public repository and release assets.

What is still needed is a callable session integration or a verified account-request interception layer below the captured fetch, with safe startup ordering. Proceed only if a custom session can satisfy the native engine's checks without relying on an official login, leaking custom credentials to official services, or replacing the file engine. Account-changing verification needs a clean/dedicated mobile test environment; do not sign out the current phone account merely to run a probe.

If that gate passes, the subsequent work remains: plugin-owned mobile login/vault selection, direct WSS bootstrap, exact iOS Origin support on the server, session expiry/revocation handling, suspension/resumption, replay recovery and the full iPhone acceptance suite. Android then needs its own source/origin inspection and device qualification. Those steps are deliberately not represented as complete by this release.
