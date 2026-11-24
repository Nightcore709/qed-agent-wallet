#!/bin/bash
# Local review only. Key is read without echo, never saved or passed as an argument.
set +x
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
export PORT="${PORT:-4178}"
export QED_SANDBOX_PORT="${QED_SANDBOX_PORT:-8768}"
export QED_DEMO_ANVIL_PORT="${QED_DEMO_ANVIL_PORT:-8668}"
export QED_IDLE_RESET_MIN=180
export QED_MAX_OPS_PER_HOUR=200
export QED_MAX_QUESTIONS_PER_HOUR=200
export QED_PUBLIC_DEMO=0
unset QED_OFFLINE
for port in "$PORT" "$QED_SANDBOX_PORT" "$QED_DEMO_ANVIL_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    printf 'Local review port %s is occupied; stop that known instance or choose unused ports. Nothing was stopped.\n' "$port"
    exit 1
  fi
done
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  printf 'Anthropic key (hidden; used only by this local process): '
  IFS= read -r -s ANTHROPIC_API_KEY
  printf '\n'
fi
if [ -z "$ANTHROPIC_API_KEY" ]; then printf 'No key supplied. Nothing started.\n'; exit 1; fi
export ANTHROPIC_API_KEY
printf 'Starting isolated QED locally on port %s. Ctrl+C stops it. No deployment occurs.\n' "$PORT"
exec node --import tsx agent/scripts/demo-server.mjs
