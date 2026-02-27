#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
EXT_PATH="$REPO_ROOT/open-session-files.ts"

if [[ ! -f "$EXT_PATH" ]]; then
  echo "Extension file not found: $EXT_PATH" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/agent" "$TMP/cwd"
cd "$TMP/cwd"

unset PI_OPEN_FILE_COMMAND PI_OPEN_FILE_MODE PI_OPEN_FILE_SHORTCUT

PI_CODING_AGENT_DIR="$TMP/agent" \
  pi --no-session \
     --no-extensions \
     --no-skills \
     --no-prompt-templates \
     --no-themes \
     -e "$EXT_PATH"
