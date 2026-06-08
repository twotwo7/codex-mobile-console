#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/runtime/safe-restart.log}"

mkdir -p "$(dirname "$LOG_FILE")"
nohup "$ROOT_DIR/scripts/restart-when-idle.sh" >>"$LOG_FILE" 2>&1 &
echo "Queued safe restart with pid $!. Logs: $LOG_FILE"
