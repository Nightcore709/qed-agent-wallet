#!/usr/bin/env bash
# The local review build of QED, started, stopped or restarted with one command (R12: "one coherent, locally runnable
# application with its exact URL and launch instructions").
#
#   scripts/review-build.sh status     what is running on 5174 (interface, live reload), 5175 (API and built interface),
#                                      5176 (wallet service; its local chain, found by data/rail/anvil.pid: since R13 it
#                                      listens on a port browsers refuse and is reached over a private socket, F-14)
#                                      and the engine
#   scripts/review-build.sh stop       stops them gracefully (SIGTERM, then waits); never SIGKILL
#   scripts/review-build.sh start      builds the interface; archives the stopped wallet service's data under the backup
#                                      key; starts the wallet service with its secrets sealed at rest (QED_RAIL_SEAL=1,
#                                      docs/ENCRYPTION.md section 9) only if a key-encryption key already exists (never
#                                      made here: npm run keys:init and its escrow are the operator's) and that archive
#                                      succeeded; then the engine and the API together (a database at an older schema is
#                                      migrated once, after a sealed copy; keys in ~/.qed/keys), then the live-reload
#                                      interface
#   scripts/review-build.sh restart    stop, then start
#   scripts/review-build.sh logs-private   makes every log owner-only (mode 600), those already there included
#
# Open http://localhost:5174 (the name localhost: a passkey is bound to it). Logs: data/review-*.log.
set -euo pipefail
# Everything this script starts, and every file it or they create, is private to the owner: logs mode 600, folders 700
# (SE8: logs were written under the default umask, mode 644; a log can hold request paths and error text).
umask 077
APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"
LOGS="${QED_LOG_DIR:-$APP/data}"
export PATH="$HOME/.foundry/bin:$PATH"

pid_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
# the wallet service's chain: the pid its pid file names, if that process is an Anvil; else one still on 8546 (started
# before R13, when the chain listened there)
chain_pid() { local p; p=$(cat "$APP/data/rail/anvil.pid" 2>/dev/null || true); if [ -n "$p" ] && ps -p "$p" -o command= 2>/dev/null | grep -q anvil; then echo "$p"; else pid_on 8546; fi; }
engine_pid() { for p in $(pgrep -f "node server/main.ts engine" || true); do [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$APP" ] && echo "$p"; done | head -1; }
wait_gone() { local pid=$1 i; for i in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done; echo "  process $pid did not stop within 20 s" >&2; return 1; }
# the wallet service listens before it is ready, and stays up answering 503 when its start is refused (a missing key or
# secret, for example), so its readiness is waited for, and a refusal is shown with its reason
wait_ready() { local i code; for i in $(seq 1 360); do code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5176/health || true); [ "$code" = 200 ] && return 0; sleep 0.5; done; echo "  the wallet service did not become ready within 180 s:" >&2; grep -a "\[rail\] failed to start" "$LOGS/rail.log" | tail -1 >&2; return 1; }
wait_port() { local port=$1 i; for i in $(seq 1 120); do [ -n "$(pid_on "$port")" ] && return 0; sleep 0.5; done; echo "  nothing answered on $port within 60 s; see the log" >&2; return 1; }

# a log made before the umask was set stays at its old mode until it is changed
logs_private() { mkdir -p "$LOGS"; local f; for f in "$LOGS"/*.log; do [ -f "$f" ] && chmod 600 "$f"; done; return 0; }

status() {
  printf '%-34s %s\n' "interface, live reload (5174)" "$(pid_on 5174)"
  printf '%-34s %s\n' "API and built interface (5175)" "$(pid_on 5175)"
  printf '%-34s %s\n' "wallet service (5176)" "$(pid_on 5176)"
  printf '%-34s %s\n' "local chain" "$(chain_pid)"
  printf '%-34s %s\n' "engine" "$(engine_pid)"
  echo "(an empty value means not running)"
}

stop() {
  local p
  for port in 5174 5175; do p=$(pid_on $port); [ -n "$p" ] && { echo "stopping $port (pid $p)"; kill -TERM "$p"; wait_gone "$p"; }; done
  p=$(engine_pid); [ -n "$p" ] && { echo "stopping the engine (pid $p)"; kill -TERM "$p"; wait_gone "$p"; }
  p=$(pid_on 5176); [ -n "$p" ] && { echo "stopping the wallet service (pid $p)"; kill -TERM "$p"; wait_gone "$p"; }
  p=$(chain_pid); [ -n "$p" ] && { echo "stopping the local chain (pid $p)"; kill -TERM "$p"; wait_gone "$p"; }
  return 0
}

backup_rail() {
  # The wallet service's data, sealed under the backup key while nothing holds it open (ENCRYPTION.md section 7, item 7).
  [ -n "$(pid_on 5176)" ] && { echo "the wallet service is running; not backing up its data" >&2; return 1; }
  local args=()
  for f in data/rail.db data/rail.db-wal data/rail.db-shm data/rail/master.key data/rail/master.key.sealed data/rail/cosigner.key data/rail/cosigner.key.sealed data/rail/keyring.json data/rail/cosigner-state.json data/rail/anvil-state.hex; do [ -f "$f" ] && args+=(--file "$APP/$f"); done
  [ ${#args[@]} -eq 0 ] && { echo "no wallet service data to back up"; return 0; }
  node scripts/plaintext-copies.ts archive "${args[@]}" --assume-closed "$APP/data/rail.db" --out "${QED_BACKUP_DIR:-$HOME/.qed/backups}/wallet-service"
}

start() {
  [ -n "$(pid_on 5175)" ] && { echo "a review API is already running on 5175; use restart" >&2; return 1; }
  logs_private
  echo "building the interface"; npm run -s build > "$LOGS/review-build.log" 2>&1
  # each service detached: no input from this terminal, output to its log, and no subshell left waiting on it
  # (a subshell that waited on the wallet service held the caller's output open, 24 Nov)
  # the wallet service's secrets are sealed only when a key-encryption key exists and its stopped data were archived
  # first (independent review of 09db70b, M-2); without either it starts as before, and already sealed secrets are read
  # sealed either way
  # the archive comes first, so it holds the files exactly as the stopped service left them, whatever prepare finds
  # (re-check of d67c514, N-6); then prepare, which never makes a key-encryption key nor a keyring for sealed secrets
  local seal=0 archived=0
  if [ -z "$(pid_on 5176)" ]; then
    if backup_rail; then archived=1; else echo "  the wallet service's data could not be archived, so its secrets are not sealed this time" >&2; fi
    if [ "$archived" = 1 ] && node scripts/wallet-sealing.ts prepare; then seal=1; fi
  fi
  echo "starting the wallet service$([ "$seal" = 1 ] && echo ', its secrets sealed at rest')"
  ( cd chain && export QED_RAIL_SEAL=$seal && exec nohup node serve.ts >> "$LOGS/rail.log" 2>&1 < /dev/null ) & disown; wait_port 5176; wait_ready || return 1
  echo "starting the engine and the API"
  nohup npm run -s engine >> "$LOGS/review-engine.log" 2>&1 < /dev/null & disown
  QED_WEB_PORT=5174 nohup npm run -s api >> "$LOGS/review-api.log" 2>&1 < /dev/null & disown
  wait_port 5175
  echo "starting the live-reload interface"; nohup npm run -s dev >> "$LOGS/vite-dev.log" 2>&1 < /dev/null & disown
  wait_port 5174
  echo "Open http://localhost:5174"
  status
}

case "${1:-}" in
  status) status ;;
  logs-private) logs_private ;;
  stop) stop ;;
  start) start ;;
  restart) stop; start ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
