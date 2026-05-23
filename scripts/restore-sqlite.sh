#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "Usage: scripts/restore-sqlite.sh <backup-path>" >&2
  exit 1
fi

BACKUP_PATH="$1"
SERVICE="${SERVICE:-app}"
DATABASE_PATH="${DATABASE_PATH:-/data/mowan.sqlite}"

if [ ! -f "$BACKUP_PATH" ]; then
  echo "Backup file not found: $BACKUP_PATH" >&2
  exit 1
fi

docker compose stop "$SERVICE"
docker compose run --rm --no-deps --entrypoint sh "$SERVICE" -c "mkdir -p \"\$(dirname '$DATABASE_PATH')\" && rm -f '$DATABASE_PATH' '$DATABASE_PATH-wal' '$DATABASE_PATH-shm'"
docker compose cp "$BACKUP_PATH" "$SERVICE:$DATABASE_PATH"
docker compose start "$SERVICE"

echo "SQLite database restored from $BACKUP_PATH"
