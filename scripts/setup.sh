#!/bin/bash
# Interactive preparation only. Never source credentials or enable shell tracing.
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PREPARED_BUN="$ROOT/.upstream/toolchain/node_modules/.bin/bun"
if [[ -x "$PREPARED_BUN" ]]; then
  BUN="$PREPARED_BUN"
elif command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
else
  printf '%s\n' 'Bun is required. Prepare the repository runtime or install Bun explicitly first.' >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then
  set -- --config "$ROOT/config.local.json"
fi
for argument in "$@"; do
  if [[ "$argument" == --help ]]; then
    exec "$BUN" --no-env-file "$ROOT/src/cli.ts" setup "$@"
  fi
done
# A pipe may carry the script, not passwords. Native setup independently checks tty.
if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  printf '%s\n' 'Setup requires a controlling terminal; no piped secret fallback is supported.' >&2
  exit 1
fi
exec "$BUN" --no-env-file "$ROOT/src/cli.ts" setup "$@" <&3 3>&-
