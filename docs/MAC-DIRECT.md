# Direct Sync on Mac

The Mac Direct Sync test build uses the same Vault Sync Bridge settings as iPhone. Enter the server address, sign in to the custom account, select an existing encrypted remote vault, and supply its encryption password. The attachment toggles and activity log use the native Sync settings on each device.

Direct mode sends HTTPS account requests to the configured origin and opens a direct WebSocket to that server. A Mac request helper rejects HTTP redirects. The iPhone uses Obsidian's mobile HTTP helper. Both share the session, vault picker, settings and WebSocket bootstrap. Per-build fingerprints guard the native account binding. The server API is the same one used by Vault Sync Bridge 0.2.0.

| | Original Mac adapter | Mac Direct Sync |
| --- | --- | --- |
| Availability | Existing routed setups and other supported desktop builds | Default for fresh setups on macOS with Obsidian 1.15.1 |
| Login and vault selection | Native Obsidian settings | Bridge settings shared with iPhone |
| Network path | Electron account routing and embedded local relay | Direct HTTPS and WebSocket |
| Existing Mac connection | Keep this mode for your configured vault | Clean profile and unconnected local vault required |

The published [0.2.0 release](https://github.com/ama156/native-vault-sync/releases/tag/0.2.0) still contains the original Mac adapter. To build the development version from this repository, run `npm ci` and `npm run build:plugin`. Use the files from `plugin/dist/`.

## Try the local build

1. Use a disposable Mac profile with Obsidian **1.15.1**, a fresh native account state, and an unconnected test vault. Enable the native Sync core plugin. If needed, create an encrypted remote **test vault** using the original desktop adapter in a separate profile.
2. Put `main.js` and `manifest.json` in the test vault's `.obsidian/plugins/vault-sync-bridge/` directory and enable **Vault Sync Bridge**.
3. In **Settings → Vault Sync Bridge**, open the Direct Sync settings.
4. Enter your HTTPS server origin and sign in in bridge settings. Select the remote test vault and use **Unlock and connect**. If the app previously saved an empty signed-out account record, use **Prepare empty account record** in the same disposable profile and restart.

Direct Sync is the default for fresh Mac 1.15.1 setups. Existing routed setups and explicit selections keep their current adapter. To opt back into desktop routing, sign out in bridge settings, choose **Use desktop routing after restart**, then restart. It refuses existing native account sessions and vaults already connected through another adapter. Moving an existing Mac setup to Direct Sync requires a separate migration workflow. Use **Sign out / disable** in bridge settings to stop Direct Sync on the test vault. The Mac and iPhone settings are saved separately so a vault's synced plugin settings cannot activate one mode on the other platform.

## Development verification

`npm run test:plugin` covers platform selection, both mobile load paths, account guards, secret storage, and the original desktop relay. The `tools/mac-direct-proof.cjs` harness runs two copied Obsidian 1.15.1 apps with isolated profiles and a disposable 0.2.0 server. Supply absolute or relative paths through `SYNC_TEST_ELECTRON`, `OBSIDIAN_TEST_ASAR` (desktop 1.15.1), `SYNC_TEST_BOOTSTRAP_ASAR`, `SYNC_TEST_REFERENCE_ASAR` (desktop 1.8.7, for test vault crypto metadata), and `SYNC_TEST_BINARY`. Build the plugin first with `npm run build:plugin`. The harness uses synthetic data and a loopback connection.

The Mac sandbox run passed login, vault selection, encrypted note sync, reverse transfer of an attachment over 2 MiB, restart recovery, sign-out, and opening bridge settings in the Mac app. The test used copied app resources and two disposable Apple Silicon profiles.
