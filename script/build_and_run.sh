#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="ChatKJBTerminal"
BUNDLE_ID="com.chatkjb.terminal"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/.artifacts/ChatKJB Terminal.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
NODE_RUNTIME="$APP_BUNDLE/Contents/Resources/Runtime/node"
BACKEND_ENTRY="$APP_BUNDLE/Contents/Resources/Backend/gui-entry.mjs"

main_app_pids() {
  /bin/ps -axo pid=,command= | /usr/bin/awk -v target="$APP_BINARY" '
    {
      pid = $1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
      if ($0 == target || index($0, target " -psn_") == 1) print pid
    }
  '
}

supervisor_pgids() {
  /bin/ps -axo pid=,pgid=,command= | /usr/bin/awk -v target="$APP_BINARY --backend-supervisor " '
    {
      pgid = $2
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", $0)
      if (index($0, target) == 1) print pgid
    }
  ' | /usr/bin/sort -nu
}

backend_pgids() {
  /bin/ps -axo pgid=,command= | /usr/bin/awk -v target="$NODE_RUNTIME $BACKEND_ENTRY --control-fd 3" '
    {
      pgid = $1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
      if (index($0, target) == 1) print pgid
    }
  ' | /usr/bin/sort -nu
}

remaining_gui_pgids() {
  { supervisor_pgids; backend_pgids; } | /usr/bin/sort -nu
}

stop_existing() {
  local main_pids
  main_pids="$(main_app_pids)"
  if [[ -n "$main_pids" ]]; then kill -TERM $main_pids >/dev/null 2>&1 || true; fi
  for _ in {1..120}; do
    if [[ -z "$(main_app_pids)" ]]; then break; fi
    sleep 0.1
  done
  main_pids="$(main_app_pids)"
  if [[ -n "$main_pids" ]]; then kill -KILL $main_pids >/dev/null 2>&1 || true; fi

  for _ in {1..120}; do
    if [[ -z "$(remaining_gui_pgids)" ]]; then return; fi
    sleep 0.1
  done
  local pgids
  pgids="$(remaining_gui_pgids)"
  for pgid in $pgids; do kill -TERM -- "-$pgid" >/dev/null 2>&1 || true; done
  for _ in {1..60}; do
    if [[ -z "$(remaining_gui_pgids)" ]]; then return; fi
    sleep 0.1
  done
  pgids="$(remaining_gui_pgids)"
  for pgid in $pgids; do kill -KILL -- "-$pgid" >/dev/null 2>&1 || true; done
}

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

stop_existing
cd "$ROOT_DIR"
npm run gui:macos:build

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    exec /usr/bin/lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    exec /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    exec /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    node "$ROOT_DIR/scripts/smoke-macos-app.mjs"
    open_app
    for _ in {1..100}; do
      if [[ -n "$(main_app_pids)" ]]; then
        echo "ChatKJB Terminal portable smoke passed and the main app process is running"
        exit 0
      fi
      sleep 0.1
    done
    echo "ChatKJB Terminal did not start" >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
