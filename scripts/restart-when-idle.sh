#!/usr/bin/env bash
set -euo pipefail

SERVICE="${SERVICE:-codex-mobile-console.service}"
TIMEOUT_SECONDS="${SAFE_RESTART_TIMEOUT:-3600}"
INTERVAL_SECONDS="${SAFE_RESTART_INTERVAL:-5}"
MARKER_FILE="${MARKER_FILE:-data/restart-marker.json}"
started_at="$(date +%s)"

service_main_pid() {
  systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true
}

has_app_codex_child() {
  local main_pid
  main_pid="$(service_main_pid)"
  [[ -n "$main_pid" && "$main_pid" != "0" ]] || return 1

  local pid current parent
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    current="$pid"
    while [[ -n "$current" && "$current" != "1" ]]; do
      parent="$(ps -o ppid= -p "$current" 2>/dev/null | tr -d ' ')"
      [[ -n "$parent" ]] || break
      if [[ "$parent" == "$main_pid" ]]; then
        return 0
      fi
      current="$parent"
    done
  done < <(pgrep -f 'codex exec' || true)

  return 1
}

while has_app_codex_child; do
  now="$(date +%s)"
  if (( now - started_at > TIMEOUT_SECONDS )); then
    echo "Timed out waiting for Codex child processes to exit." >&2
    exit 1
  fi
  sleep "$INTERVAL_SECONDS"
done

mkdir -p "$(dirname "$MARKER_FILE")"
tmp_marker="${MARKER_FILE}.tmp"
cat >"$tmp_marker" <<JSON
{
  "version": 1,
  "reason": "restart-when-idle",
  "requestedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pid": $$,
  "running": []
}
JSON
mv "$tmp_marker" "$MARKER_FILE"

systemctl restart "$SERVICE"
