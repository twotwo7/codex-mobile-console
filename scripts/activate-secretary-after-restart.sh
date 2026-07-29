#!/usr/bin/env bash
set -euo pipefail

OLD_PID="${1:?old service pid is required}"
APP_URL="${APP_URL:-http://127.0.0.1:7072}"
PASSWORD_FILE="${PASSWORD_FILE:-data/admin-password.txt}"

for _ in $(seq 1 180); do
  new_pid="$(systemctl show -p MainPID --value codex-mobile-console.service 2>/dev/null || true)"
  if [[ -n "$new_pid" && "$new_pid" != "0" && "$new_pid" != "$OLD_PID" ]] && curl -fsS "$APP_URL/api/healthz" >/dev/null; then
    break
  fi
  sleep 2
done

APP_URL="$APP_URL" PASSWORD_FILE="$PASSWORD_FILE" /usr/bin/node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';

const appUrl = process.env.APP_URL;
const password = (await readFile(process.env.PASSWORD_FILE, 'utf8')).trim();
const login = await fetch(`${appUrl}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password })
});
if (!login.ok) throw new Error(`secretary post-restart login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('secretary post-restart login returned no cookie');
const activate = await fetch(`${appUrl}/api/secretary/activate`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: '{}'
});
const data = await activate.json();
if (!activate.ok || data.session?.kind !== 'secretary') {
  throw new Error(`secretary post-restart activation failed: ${activate.status}`);
}
NODE
