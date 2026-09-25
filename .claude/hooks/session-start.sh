#!/bin/bash
# SessionStart (Claude Code on the web): зависимости для lint/typecheck/test/build.
# Только в облачной сессии; идемпотентно. Именно `npm ci`: он не меняет package-lock.json
# и учитывает allowScripts (postinstall esbuild для tsx) — см. «Грабли» в docs/STATUS.md.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
stamp="node_modules/.package-lock.sha256"
want="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
  exit 0
fi
npm ci --no-audit --no-fund
echo "$want" > "$stamp"
