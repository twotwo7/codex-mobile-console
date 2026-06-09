#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-codex-mobile-console}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-7072}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
SERVICE_GROUP="${SERVICE_GROUP:-$(id -gn)}"
SERVICE_HOME="${SERVICE_HOME:-${HOME:-/root}}"
CODEX_HOME="${CODEX_HOME:-$SERVICE_HOME/.codex}"
PROJECTS_ROOT="${PROJECTS_ROOT:-$SERVICE_HOME/Projects}"

if [[ -z "$NODE_BIN" ]]; then
  echo "node was not found. Install Node.js 20+ first or set NODE_BIN=/path/to/node." >&2
  exit 1
fi

if [[ -z "$CODEX_BIN" ]]; then
  echo "codex was not found. Install Codex CLI first or set CODEX_BIN=/path/to/codex." >&2
  exit 1
fi

if [[ ! -x "$CODEX_BIN" ]]; then
  echo "CODEX_BIN is not executable: $CODEX_BIN" >&2
  exit 1
fi

USER_UNIT_LINES=""
if [[ "$SERVICE_USER" != "root" ]]; then
  USER_UNIT_LINES="User=$SERVICE_USER
Group=$SERVICE_GROUP"
fi

cat >"$SERVICE_FILE" <<UNIT
[Unit]
Description=Codex Mobile Console
After=network.target

[Service]
Type=simple
$USER_UNIT_LINES
WorkingDirectory=$ROOT_DIR
Environment=NODE_ENV=production
Environment=HOME=$SERVICE_HOME
Environment=HOST=$HOST
Environment=PORT=$PORT
Environment=CODEX_HOME=$CODEX_HOME
Environment=PROJECTS_ROOT=$PROJECTS_ROOT
Environment=CODEX_BIN=$CODEX_BIN
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_BIN $ROOT_DIR/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
echo "Installed $SERVICE_FILE"
echo "Run: systemctl enable --now $SERVICE_NAME"
