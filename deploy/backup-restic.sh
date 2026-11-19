#!/usr/bin/env bash
# Run as root on Linux. Restic credentials remain external to the Go server.
set -Eeuo pipefail
umask 077
mode=${VAULT_SYNC_BACKUP_MODE:-systemd}
root=${VAULT_SYNC_BACKUP_ROOT:-/var/backups/vault-sync}
config=${VAULT_SYNC_CONFIG:-/etc/vault-sync/config.json}
binary=${VAULT_SYNC_BINARY:-/usr/local/bin/vault-sync-server}
service=${VAULT_SYNC_SERVICE:-vault-sync}
owner=${VAULT_SYNC_SERVICE_USER:-vault-sync}
container=${VAULT_SYNC_CONTAINER:-vault-sync}
source_dir=${VAULT_SYNC_SOURCE_DIR:-/opt/native-vault-sync}
[[ $root = /* && $root != / ]] || { echo 'Backup root must be an absolute private directory' >&2; exit 1; }
[[ $(id -u) = 0 ]] || { echo 'Run this wrapper as root; Go commands use the service UID' >&2; exit 1; }
command -v restic >/dev/null
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}"
install -d -m 0700 "$root"
exec 9>"$root/backup.lock"
flock -n 9 || { echo 'Another backup job is running' >&2; exit 1; }
compose() { (cd "$source_dir" && docker compose "$@"); }
was_running=false
restart_pending=false
restart_server() {
  case "$mode" in
    systemd) systemctl start "$service" ;;
    compose) compose up -d --no-build --wait vault-sync ;;
    docker) docker start "$container" >/dev/null ;;
  esac
  restart_pending=false
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if $restart_pending; then
    if ! restart_server; then echo 'ERROR: failed to restart Sync service' >&2; status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$mode" in
  systemd)
    if systemctl is-active --quiet "$service"; then was_running=true; restart_pending=true; systemctl stop "$service"; fi
    uid=$(id -u "$owner"); gid=$(id -g "$owner") ;;
  compose)
    if [[ -n $(compose ps --status running -q vault-sync) ]]; then was_running=true; restart_pending=true; compose stop vault-sync; fi
    uid=10001; gid=10001 ;;
  docker)
    if [[ $(docker inspect -f '{{.State.Running}}' "$container") = true ]]; then was_running=true; restart_pending=true; docker stop "$container" >/dev/null; fi
    image=$(docker inspect -f '{{.Config.Image}}' "$container")
    uid=10001; gid=10001 ;;
  *) echo 'Mode must be systemd, compose or docker' >&2; exit 1 ;;
esac
job=$(mktemp -d "$root/job-XXXXXXXX")
chmod 0700 "$job"
chown "$uid:$gid" "$job"
# Container users need traverse-only access, not directory listing access.
chmod 0711 "$root"
case "$mode" in
  systemd) runuser -u "$owner" -- "$binary" backup --config "$config" --format directory --output "$job/snapshot" ;;
  compose)
    (cd "$source_dir" && VAULT_SYNC_BACKUP_MOUNT="$root" docker compose run --rm --no-deps -T vault-sync backup --format directory --output "/backups/${job##*/}/snapshot") ;;
  docker)
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=64m \
      --volumes-from "$container" --mount "type=bind,src=$root,dst=/backups" "$image" \
      backup --format directory --output "/backups/${job##*/}/snapshot" ;;
esac
if $was_running; then restart_server; fi
# Upload only a fully completed snapshot. A failure leaves it available to retry.
restic backup "$job/snapshot" --tag vault-sync
rm -rf -- "$job"
echo 'Sync snapshot uploaded successfully; retention was not changed.'
