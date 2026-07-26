#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router"
SCRIPT="$ROOT/src/index.js"
if [ ! -f "$SCRIPT" ]; then
  echo "Router entrypoint not found: $SCRIPT" >&2
  exit 1
fi
exec node "$SCRIPT" "$@"
