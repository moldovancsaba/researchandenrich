#!/usr/bin/env bash
set -euo pipefail

# Resolve the router relative to THIS script, so the repo runs wherever it is
# cloned. This previously hardcoded
# $HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router,
# which meant the launcher only worked inside one operator's OpenClaw workspace
# layout, under a directory name ("contentcreator") that is not even this
# repo's name. A clone anywhere else -- CI, a second machine, a different agent
# runtime -- failed with "Router entrypoint not found".
#
# SEYU_SEARCH_ROUTER_ROOT still overrides, for a deployment that genuinely
# keeps the router elsewhere.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SEYU_SEARCH_ROUTER_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)/seyu-search-router}"
SCRIPT="$ROOT/src/index.js"

if [ ! -f "$SCRIPT" ]; then
  echo "Router entrypoint not found: $SCRIPT" >&2
  echo "Set SEYU_SEARCH_ROUTER_ROOT if the router lives outside this repo." >&2
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "Router dependencies are not installed. Run:" >&2
  echo "  npm --prefix \"$ROOT\" ci" >&2
  exit 1
fi

exec node "$SCRIPT" "$@"
