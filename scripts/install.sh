#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/twotwo7/codex-mobile-console.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/codex-mobile-console}"
SERVICE_NAME="${SERVICE_NAME:-codex-mobile-console}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-7072}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
SUDO_BIN=""
INSTALL_USER="$(id -un)"
INSTALL_GROUP="$(id -gn)"
INSTALL_HOME="${HOME:-$(getent passwd "$INSTALL_USER" | cut -d: -f6)}"
CODEX_HOME="${CODEX_HOME:-$INSTALL_HOME/.codex}"
PROJECTS_ROOT="${PROJECTS_ROOT:-$INSTALL_HOME/Projects}"

log() {
  printf '[codex-mobile-console] %s\n' "$*"
}

fail() {
  printf '[codex-mobile-console] error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required."
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "this installer currently supports Linux servers only."
fi

if [[ "$(id -u)" != "0" ]]; then
  need_command sudo
  SUDO_BIN="sudo"
else
  INSTALL_USER="root"
  INSTALL_GROUP="root"
  INSTALL_HOME="/root"
  CODEX_HOME="${CODEX_HOME:-/root/.codex}"
  PROJECTS_ROOT="${PROJECTS_ROOT:-/root/Projects}"
fi

need_command git
need_command npm
need_command curl
need_command systemctl
need_command sqlite3
[[ -n "$NODE_BIN" ]] || fail "node was not found. Install Node.js 20+ first."

NODE_MAJOR="$("$NODE_BIN" -e "console.log(Number(process.versions.node.split('.')[0]))")"
if (( NODE_MAJOR < 20 )); then
  fail "Node.js 20+ is required. Current: $("$NODE_BIN" --version)"
fi

if [[ -z "$CODEX_BIN" ]]; then
  fail "codex was not found in PATH. Install and authenticate Codex CLI first, or rerun with CODEX_BIN=/path/to/codex."
fi

if [[ ! -x "$CODEX_BIN" ]]; then
  fail "CODEX_BIN is not executable: $CODEX_BIN"
fi

log "install directory: $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "updating existing repository"
  if [[ -n "$SUDO_BIN" ]]; then
    $SUDO_BIN chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  fi
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  log "cloning repository"
  $SUDO_BIN mkdir -p "$(dirname "$INSTALL_DIR")"
  tmp_dir="$(mktemp -d)"
  git clone --branch "$BRANCH" "$REPO_URL" "$tmp_dir"
  $SUDO_BIN rm -rf "$INSTALL_DIR"
  $SUDO_BIN mv "$tmp_dir" "$INSTALL_DIR"
  if [[ -n "$SUDO_BIN" ]]; then
    $SUDO_BIN chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  fi
fi

log "installing npm dependencies"
cd "$INSTALL_DIR"
npm install --omit=optional
mkdir -p "$PROJECTS_ROOT"

log "using Codex binary: $CODEX_BIN"

log "installing systemd service"
$SUDO_BIN env \
  SERVICE_NAME="$SERVICE_NAME" \
  NODE_BIN="$NODE_BIN" \
  HOST="$HOST" \
  PORT="$PORT" \
  CODEX_BIN="$CODEX_BIN" \
  CODEX_HOME="$CODEX_HOME" \
  PROJECTS_ROOT="$PROJECTS_ROOT" \
  SERVICE_USER="$INSTALL_USER" \
  SERVICE_GROUP="$INSTALL_GROUP" \
  SERVICE_HOME="$INSTALL_HOME" \
  "$INSTALL_DIR/scripts/install-systemd.sh"

log "starting service"
$SUDO_BIN systemctl enable --now "$SERVICE_NAME"

log "health check"
for _ in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/api/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/healthz" >/dev/null \
  || fail "service did not pass health check. Run: systemctl status $SERVICE_NAME --no-pager"

PASSWORD_FILE="$INSTALL_DIR/data/admin-password.txt"
log "installed successfully"
printf '\nLocal URL: http://127.0.0.1:%s\n' "$PORT"
printf 'Password: %s\n' "$($SUDO_BIN tr -d '\r\n' < "$PASSWORD_FILE")"
cat <<MSG

Next steps:
1. Put the app behind HTTPS before phone access.
2. Keep HOST=127.0.0.1 when using a reverse proxy.
3. Read deployment guide: $INSTALL_DIR/docs/deployment.md
4. Make sure Codex is authenticated for service user: $INSTALL_USER

Useful commands:
  systemctl status $SERVICE_NAME --no-pager
  journalctl -u $SERVICE_NAME -f
  $INSTALL_DIR/scripts/safe-restart.sh
MSG
