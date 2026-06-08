#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:7072}"
PASSWORD_FILE="${PASSWORD_FILE:-data/admin-password.txt}"
COOKIE_FILE="${COOKIE_FILE:-runtime/safe-restart.cookies}"

mkdir -p "$(dirname "$COOKIE_FILE")"

password="$(tr -d '\r\n' < "$PASSWORD_FILE")"
curl -fsS -c "$COOKIE_FILE" \
  -H 'content-type: application/json' \
  -d "{\"password\":\"${password}\"}" \
  "$APP_URL/api/login" >/dev/null

curl -fsS -b "$COOKIE_FILE" \
  -H 'content-type: application/json' \
  -X POST \
  -d '{"reason":"safe-restart"}' \
  "$APP_URL/api/admin/restart"
printf '\n'
