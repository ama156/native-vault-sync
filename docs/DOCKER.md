# Linux binary, Docker and Compose — server 0.2.0

All deployments run the same Go binary, native API, SQLite schema and ciphertext format. Keep the backend private behind HTTPS. See [security](SECURITY.md), [multi-user administration/migration](MULTIUSER.md) and [ZIP/restic backups](BACKUPS.md).

The Dockerfile builds a static amd64/arm64 binary into an unprivileged scratch image with certificate roots/license notices. No shell/package manager or separate database is needed. Build locally; this release does not publish a registry image.

## Docker Compose

```sh
git clone https://github.com/ama156/native-vault-sync.git
cd native-vault-sync
docker compose build
docker compose run --rm vault-sync init \
  --public-url https://sync.example.com --email owner@example.com
docker compose up -d --wait
```

Enter a new account password at the hidden prompt. Do not initialize an existing data volume again. Containers listen on `0.0.0.0:8080` internally; the published host port is **127.0.0.1:8080** by default. This is separate from your public HTTPS URL.

Default named volumes are `vault-sync_config`, `vault-sync_data` and `vault-sync_backups`. Use the same Compose project name for initialization, serving and all administration. The image runs UID/GID 10001:10001 with a read-only root, dropped capabilities, no-new-privileges, bounded temporary storage, PID/CPU/memory limits and bounded logs. Only the mounted state and temporary paths are writable.

### Configuration and storage location

Copy `.env.example` to `.env` and edit it. Application configuration precedence is defaults → JSON config → explicitly supplied `VAULT_SYNC_*` variables → supported CLI flags. Compose passes optional application variables only when supplied; an unset variable does not overwrite a saved configuration. Copying the example supplies its displayed defaults explicitly. Invalid values fail startup.

| Variable | Purpose/default |
| --- | --- |
| `VAULT_SYNC_PUBLIC_URL` | Public HTTPS origin; saved config can supply it |
| `VAULT_SYNC_DATA_DIR` | Internal data directory; saved config supplies it unless overridden |
| `VAULT_SYNC_MAX_STORAGE_BYTES` | Global ciphertext cap, default 10 GiB |
| `VAULT_SYNC_DEFAULT_USER_STORAGE_BYTES` | Default new-user allowance, 10 GiB |
| `VAULT_SYNC_MAX_FILE_BYTES` | Global/new-user file limit, 208666624 bytes |
| `VAULT_SYNC_MAX_VAULTS` | Default user accessible-vault count, 10 |
| `VAULT_SYNC_MAX_TOTAL_VAULTS` | Global active-vault count, 1000 |
| `VAULT_SYNC_SESSION_DAYS` | New-session lifetime, 30 |
| `VAULT_SYNC_MAX_CONNECTIONS`, `VAULT_SYNC_USER_CONNECTIONS` | Global/per-user connections, 64/8 |
| `VAULT_SYNC_MAX_UPLOADS`, `VAULT_SYNC_USER_UPLOADS` | Global/per-uploader pending uploads, 16/4 |
| `VAULT_SYNC_LOGIN_CONCURRENCY` | Simultaneous Argon2 jobs, 2; each uses 64 MiB plus overhead |
| `VAULT_SYNC_GLOBAL_REQUESTS_PER_MINUTE`, `VAULT_SYNC_REQUESTS_PER_MINUTE` | Global/per-user request budgets, 6000/600 |
| `VAULT_SYNC_LOGIN_IP_PER_MINUTE`, `VAULT_SYNC_LOGIN_ACCOUNT_PER_MINUTE` | Login budgets, 30/10 |
| `VAULT_SYNC_TRUSTED_PROXIES` | Comma-separated explicit CIDRs, none by default |

Byte values are decimal integers, not suffix strings such as `10GB`. Default-user settings affect newly created accounts; use `users quota` for existing users. Global caps still apply to everybody. A container's data path must match its mounted storage and restored configuration; avoid overriding it to a different directory accidentally after restore.

Compose-only settings include `VAULT_SYNC_PORT` (host loopback port), `VAULT_SYNC_IMAGE` (local image tag), `VAULT_SYNC_MEMORY_LIMIT` (1g), `VAULT_SYNC_CPUS` (2), and the three mount selectors below. Internal port 8080 remains fixed unless you deliberately update the listener and port mapping together.

For absolute host directories instead of named volumes:

```sh
sudo install -d -m 0700 -o 10001 -g 10001 \
  /srv/vault-sync/config /srv/vault-sync/data /srv/vault-sync/backups
```

Set in `.env` before initialization:

```dotenv
VAULT_SYNC_CONFIG_MOUNT=/srv/vault-sync/config
VAULT_SYNC_DATA_MOUNT=/srv/vault-sync/data
VAULT_SYNC_BACKUP_MOUNT=/srv/vault-sync/backups
VAULT_SYNC_MAX_STORAGE_BYTES=53687091200
VAULT_SYNC_DEFAULT_USER_STORAGE_BYTES=10737418240
```

These are **host** mount paths. The container sees `/etc/vault-sync`, `/var/lib/vault-sync` and `/backups`. Do not bake host storage paths or passwords into Docker build arguments. Changing mount selection points the app at different storage; it does not migrate an existing volume automatically. Preserve/copy verified data while stopped or use backup/restore.

### Users, sharing and secrets

```sh
docker compose exec vault-sync /usr/local/bin/vault-sync-server users add \
  --email alice@example.com --name Alice
docker compose exec vault-sync /usr/local/bin/vault-sync-server users list
docker compose exec vault-sync /usr/local/bin/vault-sync-server vaults grant \
  --vault VAULT_ID --user alice@example.com
```

Use `-T` and `--password-stdin` for controlled automation. Alternatively use `--password-file /run/secrets/bootstrap_password`. `compose.secrets.yaml` demonstrates mounting a secret for a one-off init/reset operation. Set `VAULT_SYNC_BOOTSTRAP_PASSWORD_FILE` to its host source and invoke both Compose files with the password-file flag. Ensure the file is readable by UID 10001 inside the container; file-backed Compose secrets retain host ownership/permission constraints. Remove the bootstrap secret from serving invocations after use. Never put its contents in `.env`, image layers or argv.

### Containerized reverse proxy

The default suits Nginx on the host. For a containerized proxy, create a dedicated network, attach your proxy, and use:

```sh
docker network create vault-sync-proxy
docker compose -f compose.yaml -f compose.proxy.yaml up -d --wait
```

The override removes all published backend ports and connects the service to that network. Proxy to `vault-sync:8080`; configure trusted peer CIDRs precisely. This override requires a current Docker Compose version supporting `!reset`. It does not deploy or configure your proxy automatically.

## Plain Docker

```sh
docker build -t native-vault-sync:local .
docker volume create vault-sync-config
docker volume create vault-sync-data
docker run --rm -it \
  --mount source=vault-sync-config,target=/etc/vault-sync \
  --mount source=vault-sync-data,target=/var/lib/vault-sync \
  native-vault-sync:local init \
  --public-url https://sync.example.com --email owner@example.com

docker run -d --name vault-sync --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 1g --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount source=vault-sync-config,target=/etc/vault-sync \
  --mount source=vault-sync-data,target=/var/lib/vault-sync \
  --publish 127.0.0.1:8080:8080 \
  --env VAULT_SYNC_MAX_STORAGE_BYTES=53687091200 \
  native-vault-sync:local
```

Use `type=bind,src=/absolute/host/path,dst=/var/lib/vault-sync` for host directories after preparing ownership. Runtime `--env` overrides apply to the same configuration fields as Compose. Include bounded Docker log options in production. To administer a running container, use `docker exec -it vault-sync /usr/local/bin/vault-sync-server ...`.

## Linux binary/systemd

The existing installation remains supported. Install the matching Linux archive, initialize once using an unprivileged `vault-sync` user and private config/data directories, then install `deploy/vault-sync.service`. It optionally loads `/etc/vault-sync/runtime.env`; use the same runtime variables/JSON configuration as Docker, with a host data path and default listener `127.0.0.1:8080`. Do not copy the container-only wildcard listener into a public native deployment.

The supplied Nginx configuration now includes a shared snippet: install `deploy/vault-sync-proxy.conf` at `/etc/nginx/snippets/vault-sync-proxy.conf` as well as adapting `deploy/nginx.conf`. Run `nginx -t` and verify certificates/firewall before exposing HTTPS.

## Validation

```sh
npm ci
npm run test:plugin
npm run test:backup-wrapper
cd server
go test -race ./...
go vet ./...
cd ..
docker compose config --quiet
docker buildx build --platform linux/amd64 --load -t native-vault-sync:ci .
npm run test:container
```

`tools/container-smoke.cjs` uses randomized disposable projects/volumes only, verifies initialization, live administration, multipart ciphertext, restart, offline backup/restore, and plain Docker. Native and container data formats are identical. Local Compose configuration validation does not imply container execution; check the published Linux CI status and release evidence. No tests should use your main Obsidian app/profile.
