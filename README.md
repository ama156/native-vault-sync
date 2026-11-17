# Vault Sync Bridge and personal server

An experimental native-Sync-compatible personal server, desktop connection adapter and opt-in iOS test adapter. The plugin routes connections; Obsidian retains file indexing, encryption, transfer decisions, and merging. No application archive is patched. No separate desktop proxy or Docker installation is needed.

The server is a single Linux binary behind your existing HTTPS reverse proxy. The desktop plugin contains its own loopback WebSocket relay. This is an independent interoperability project, not an official Obsidian product.

## Technical documentation

- [iPhone and desktop implementation](docs/PLATFORM-ADAPTERS.md): why native account screens show the custom session, platform-specific login/routing, token storage, WebSockets and lifecycle.
- [Technical deep dive](docs/TECHNICAL-DEEP-DIVE.md): reverse-engineered client layers, permissions, account routing, encryption, native scheduling, durable storage, replay and failure boundaries.
- [API reference](docs/API-REFERENCE.md): every implemented HTTP route, JSON examples, WebSocket state machine, binary framing, history, restore and error semantics.
- [OpenAPI 3.1 JSON](docs/HTTP-API.openapi.json): importable HTTP contract. WebSocket message sequencing is documented separately in the API reference.
- [Compatibility and evidence](docs/COMPATIBILITY.md): exact app fingerprints, test reports and remaining qualification limits.
- [Mobile test build](docs/MOBILE-STATUS.md): experimental iOS account/transport adapter, native-engine proof, compatibility matrix and test installation.

## Current status

Plugin **0.1.3** adds iPhone attachment/selective-sync controls on top of the experimental **iOS 1.15.1** custom login, vault selector and direct WSS adapter. Server **0.1.2** remains compatible and unchanged. Note sync/recovery and recovered PNG/PDF transfer are user-confirmed; ZIP/EPUB and the new settings UI still need device confirmation. Broader qualification remains incomplete. Existing accounts/connections are refused. Desktop adapters remain limited to **1.8.7** and **1.15.1**; Android remains diagnostic only. Follow the [mobile test installation guide](docs/MOBILE-STATUS.md) and its evidence limits. No directory submission is planned during testing.

The plugin is **not yet published or approved in the community directory**. A release ZIP cannot be installed by pasting its URL into Obsidian's normal plugin browser. Installation through **Settings → Community plugins → Browse** requires directory publication. The repository and submission instructions are in `docs/PUBLISHING.md`.

## Install the Linux server

Choose the `amd64` archive for an x86-64 server or `arm64` for an ARM64 server. Verify `SHA256SUMS` before installation. The binary does not require Node.js, Go, Docker, or an external database on the server.

Example for a systemd-based Debian/Ubuntu server, after unpacking the matching archive:

```sh
sudo useradd --system --home-dir /var/lib/vault-sync --shell /usr/sbin/nologin vault-sync
sudo install -m 0755 vault-sync-server /usr/local/bin/vault-sync-server
sudo install -d -m 0700 -o vault-sync -g vault-sync /var/lib/vault-sync /etc/vault-sync
sudo -u vault-sync /usr/local/bin/vault-sync-server init \
  --config /etc/vault-sync/config.json \
  --data-dir /var/lib/vault-sync \
  --public-url https://obsidianvault.example.com \
  --email you@example.com
```

Enter a new account password at the terminal prompt. Use a different password from both your official account and your vault encryption password. Initialization creates one owner; public signup is disabled.

```sh
sudo install -m 0644 deploy/vault-sync.service /etc/systemd/system/vault-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now vault-sync
sudo journalctl -u vault-sync -f
```

Configure your domain and TLS certificate in Nginx. Adapt `deploy/nginx.conf` to your certificate paths, include it within the `http` context, run `sudo nginx -t`, and reload Nginx. The server binds only to `127.0.0.1:8080` by default. Its configured public URL must match the HTTPS origin used by the plugin. WebSocket frames use `/sync`; JSON account routes and `/healthz` use the same origin.

```sh
curl https://obsidianvault.example.com/healthz
```

The response should identify `vault-sync-server`, report `bridge_protocol: 1`, and have `ready: true`.

## Connect a desktop client

Once directory publication is approved:

1. Open a local vault and enable Community plugins.
2. Browse for **Vault Sync Bridge**, install, and enable it.
3. Enable the native **Sync** core plugin.
4. Open the bridge settings, enter your HTTPS origin, and test the connection.
5. Sign out of an existing official account and disconnect an existing official remote vault before activating custom routing. Local notes remain local.
6. Enable custom routing, then sign into your private-server account through native account settings.
7. Create or choose a remote vault through native Sync settings. Choose end-to-end encryption and supply a vault password.
8. Install the same plugin in every participating local vault/device and repeat the native connection flow.

Use one custom server and custom account per app profile. The adapter intentionally refuses unsupported client versions and conflicting server selections in windows sharing an Electron session.

For developer testing before publication, copy only `plugin/dist/main.js` and `plugin/dist/manifest.json` into a **disposable** vault's configured plugin directory under `plugins/vault-sync-bridge/`, then enable the plugin through Community plugins. Manual copying is a development route, not the promised public installation experience. Never point automated tests at your installed app or real profile; the development harness rejects installed app paths.

## Operations

```sh
vault-sync-server status --config /etc/vault-sync/config.json
vault-sync-server sessions list --config /etc/vault-sync/config.json
vault-sync-server sessions revoke --config /etc/vault-sync/config.json --id HASHED_SESSION_ID
vault-sync-server password-reset --config /etc/vault-sync/config.json
```

Run administrative commands as the service user, or with sufficient permissions to access its private data directory. Session IDs are hashes, not bearer tokens. Password reset revokes all sessions. Account sessions expire after 90 days; sign in again through native settings when needed.

Back up while the service is stopped. The command obtains the service's exclusive data lock and creates a consistent SQLite snapshot plus ciphertext and configuration:

```sh
sudo systemctl stop vault-sync
sudo -u vault-sync vault-sync-server backup --config /etc/vault-sync/config.json --output /var/lib/vault-sync/backup.tar.gz
sudo systemctl start vault-sync
```

Move backups to your own backup destination; there is no automatic cloud upload. Restore requires a **new configuration filename and nonexistent destination directory**:

```sh
vault-sync-server restore --archive backup.tar.gz --config /path/to/new-config.json --data-dir /path/to/new-data
```

Restore checks database integrity and ciphertext checksums. After rolling back a server to an older backup, clients with newer revision cursors must reconnect using native vault setup. The server rejects an ahead-of-server cursor rather than silently dropping changes.

Defaults are 10 vaults, 10 GiB ciphertext, and 208,666,624 plaintext bytes per file (plus the native encryption overhead on the wire). History and file tombstones count toward retained storage; automatic pruning, `purge`, sharing, and migration are unsupported. See `docs/PROTOCOL.md` for details, including vault deletion behavior.

## Build and test

Requires Node.js/npm and Go 1.27.4 or newer on the build machine:

```sh
npm ci
npm run build:plugin
npm run test:plugin
cd server
go test -race ./...
go vet ./...
cd ..
npm run release
```

`releases/` contains Linux archives, a plugin ZIP, standalone plugin release assets, a source ZIP, and checksums. No proprietary client resources, credentials, or sandbox profiles are included.

The development-only native contract harness requires an explicitly supplied **sandbox copy** of a legally obtained app bundle and a disposable loopback server. It never launches the installed application. Environment variables and the scope of its browser-task adapter are documented in `docs/COMPATIBILITY.md`.

## Network and privacy disclosure

On iOS 1.15.1, the experimental adapter uses plugin-owned account/vault screens and direct browser WebSockets, with per-instance native account guards. Other mobile builds remain inactive. See the [mobile guide](docs/MOBILE-STATUS.md) for credential storage, qualification limits and setup. This is not a whole-app firewall.

The plugin contacts only your configured server for its own operations. On desktop, native account requests to `api.obsidian.md` are intercepted and routed to that server while routing is active; unsupported account operations are blocked. Existing native request protections remain installed. The desktop plugin uses Electron's debugging transport to intercept requests and coordinates Settings/popout windows inside the app process.

Developer Tools or another debugger can detach the account interceptor. Close Developer Tools before activating the bridge. An unexpected detachment disconnects native Sync and reports a routing failure; re-enable routing afterward. Keep the bridge active when using the custom account, and sign out through native settings before disabling routing or changing servers. The adapter cannot replace native account routing while it is disabled or before it loads.

The server stores opaque paths, encrypted hashes, ciphertext, revision metadata, extensions, timestamps, and device labels. It does not receive vault encryption passwords or raw keys. Your local vault remains in Obsidian's normal local format. Account passwords use Argon2id and bearer tokens are stored only as hashes. Logs omit credentials and message bodies. There is no client telemetry, advertising, automatic dependency download, or self-updater.

## Licensing

Independent source is MIT-licensed. The project includes no proprietary Obsidian implementation. Bundled dependencies retain their licenses; see `THIRD_PARTY_NOTICES.md`. Public distribution is subject to the community directory's review and naming requirements.
