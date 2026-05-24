#!/usr/bin/env sh
set -eu

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ "${DOMAIN:-}" = "" ] && [ "${VERIFY_BASE_URL:-}" = "" ]; then
  echo "Set DOMAIN in .env or pass VERIFY_BASE_URL." >&2
  exit 1
fi

if [ "${ADMIN_USERS:-}" = "" ] && [ "${VERIFY_ADMIN_USERNAME:-}" = "" ]; then
  echo "Set ADMIN_USERS in .env or pass VERIFY_ADMIN_USERNAME/VERIFY_ADMIN_PASSWORD." >&2
  exit 1
fi

BASE_URL="${VERIFY_BASE_URL:-https://$DOMAIN}"
BASE_URL="${BASE_URL%/}"

first_admin="${VERIFY_ADMIN_PAIR:-${ADMIN_USERS:-}}"
first_admin="${first_admin%%,*}"
admin_username="${VERIFY_ADMIN_USERNAME:-${first_admin%%:*}}"
admin_password="${VERIFY_ADMIN_PASSWORD:-${first_admin#*:}}"

if [ "$admin_username" = "$admin_password" ] || [ "$admin_username" = "" ] || [ "$admin_password" = "" ]; then
  echo "Could not derive admin credentials. Set VERIFY_ADMIN_USERNAME and VERIFY_ADMIN_PASSWORD." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

log() {
  echo "[verify] $*"
}

json_escape() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

wait_for_health() {
  index=0
  while [ "$index" -lt 90 ]; do
    if curl -fsS "$BASE_URL/healthz" | grep -q '"ok":true'; then
      return 0
    fi
    index=$((index + 1))
    sleep 2
  done

  docker compose ps
  docker compose logs --tail=120 app
  docker compose logs --tail=120 caddy
  echo "Timed out waiting for $BASE_URL/healthz" >&2
  exit 1
}

login_admin() {
  login_body="$(printf '{"username":"%s","password":"%s"}' "$(json_escape "$admin_username")" "$(json_escape "$admin_password")")"
  login_output="$tmp_dir/admin-login-response.json"
  login_headers="$tmp_dir/admin-login-headers.txt"
  login_status="$(curl -sS -D "$login_headers" -o "$login_output" -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -X POST \
    --data "$login_body" \
    "$BASE_URL/api/admin/login")"

  if [ "$login_status" != "200" ] || ! grep -q '"ok":true' "$login_output"; then
    echo "Admin login failed with HTTP $login_status" >&2
    cat "$login_output" >&2
    docker compose logs --tail=80 app >&2
    exit 1
  fi

  admin_cookie_header="$(sed -n 's/^[Ss]et-[Cc]ookie: *\([^;]*\).*/\1/p' "$login_headers" | tr -d '\r' | head -n 1)"
  if [ "$admin_cookie_header" = "" ]; then
    echo "Admin login did not return a cookie." >&2
    cat "$login_headers" >&2
    exit 1
  fi
}

post_json() {
  path="$1"
  body="$2"
  cookie_header="${3:-}"
  if [ "$cookie_header" = "" ]; then
    curl -fsS -H "Content-Type: application/json" -X POST --data "$body" "$BASE_URL$path" >/dev/null
  else
    curl -fsS -H "Cookie: $cookie_header" -H "Content-Type: application/json" -X POST --data "$body" "$BASE_URL$path" >/dev/null
  fi
}

wait_for_text() {
  path="$1"
  expected="$2"
  index=0
  while [ "$index" -lt 40 ]; do
    if curl -fsS "$BASE_URL$path" | grep -Fq "$expected"; then
      return 0
    fi
    index=$((index + 1))
    sleep 1
  done

  echo "Timed out waiting for text '$expected' at $path" >&2
  exit 1
}

require_command docker
require_command curl
require_command grep
require_command sed

log "starting docker compose deployment at $BASE_URL"
docker compose up -d --build
wait_for_health

tmp_dir="$(mktemp -d)"
admin_cookie_header=""
session_id="verify$(date +%s)$$"
extra_session_id="verifyextra$(date +%s)$$"
user_text="deploy verify $session_id"
reply_text="deploy reply $session_id"

log "creating visitor session $session_id"
curl -fsS "$BASE_URL/api/chat/$session_id" >/dev/null
post_json "/api/chat/$session_id/messages" "$(printf '{"content":"%s"}' "$(json_escape "$user_text")")"

log "logging in admin $admin_username"
login_admin
log "checking admin session list"
curl -fsS -H "Cookie: $admin_cookie_header" "$BASE_URL/api/admin/sessions" | grep -Fq "$session_id"
log "sending admin reply"
post_json "/api/admin/sessions/$session_id/reply" "$(printf '{"content":"%s","delayMs":0}' "$(json_escape "$reply_text")")" "$admin_cookie_header"
wait_for_text "/api/chat/$session_id" "$reply_text"

log "restarting app and checking persistence"
docker compose restart app
wait_for_health
wait_for_text "/api/chat/$session_id" "$reply_text"

log "creating SQLite backup"
backup_path="$(sh ./scripts/backup-sqlite.sh)"
test -s "$backup_path"

log "creating post-backup session $extra_session_id"
curl -fsS "$BASE_URL/api/chat/$extra_session_id" >/dev/null
post_json "/api/chat/$extra_session_id/messages" "$(printf '{"content":"%s"}' "$(json_escape "extra after backup $extra_session_id")")"
login_admin
curl -fsS -H "Cookie: $admin_cookie_header" "$BASE_URL/api/admin/sessions" | grep -Fq "$extra_session_id"

log "restoring SQLite backup"
sh ./scripts/restore-sqlite.sh "$backup_path" >/dev/null
wait_for_health
login_admin
sessions_after_restore="$(curl -fsS -H "Cookie: $admin_cookie_header" "$BASE_URL/api/admin/sessions")"
printf "%s" "$sessions_after_restore" | grep -Fq "$session_id"
if printf "%s" "$sessions_after_restore" | grep -Fq "$extra_session_id"; then
  echo "Restore verification failed: post-backup session still exists." >&2
  exit 1
fi

docker compose ps
echo "Deployment verification passed for $BASE_URL"
