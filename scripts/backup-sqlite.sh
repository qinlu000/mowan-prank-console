#!/usr/bin/env sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-backups}"
SERVICE="${SERVICE:-app}"
DATABASE_PATH="${DATABASE_PATH:-/data/mowan.sqlite}"

mkdir -p "$BACKUP_DIR"
timestamp="$(date +%Y%m%d-%H%M%S)"
file_name="mowan-$timestamp.sqlite"
host_target="$BACKUP_DIR/$file_name"
container_target="/data/backups/$file_name"

docker compose exec -T "$SERVICE" node scripts/sqlite-backup.js "$DATABASE_PATH" "$container_target" >/dev/null
docker compose cp "$SERVICE:$container_target" "$host_target" >/dev/null
docker compose exec -T "$SERVICE" rm -f "$container_target" >/dev/null 2>&1 || true

echo "$host_target"
