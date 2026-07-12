#!/bin/bash
set -u

: "${BOT:?BOT must be set to 'blue' or 'midnight'}"
: "${CHAIN_ID:?CHAIN_ID must be set}"

DRY_RUN="${QUEUED_DRY_RUN:-}"
is_dry_run() {
  case "$DRY_RUN" in
  1 | true | TRUE | True) return 0 ;;
  *) return 1 ;;
  esac
}

if ! is_dry_run; then
  : "${SIGNER_PRIVATE_KEY:?SIGNER_PRIVATE_KEY must be set unless QUEUED_DRY_RUN is enabled}"
fi

export MORPHO_BOTS_HOME="${MORPHO_BOTS_HOME:-/data/morpho-bots}"
export SIGNER_SOCKET="${SIGNER_SOCKET:-$MORPHO_BOTS_HOME/signer.sock}"
mkdir -p "$MORPHO_BOTS_HOME"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${CLI_BIN:-$REPO_ROOT/tools/cli/dist/main.js}"
QUEUED="${QUEUED_BIN:-$REPO_ROOT/services/queued/dist/main.js}"
SIGNER="${SIGNER_BIN:-$REPO_ROOT/packages/signer/src/main.ts}"
export QUEUED_SOCKET="${QUEUED_SOCKET:-$MORPHO_BOTS_HOME/queued-$CHAIN_ID.sock}"
POSITIONS_PIPE="$MORPHO_BOTS_HOME/positions-$CHAIN_ID.pipe"
TRANSACTIONS_PIPE="$MORPHO_BOTS_HOME/transactions-$CHAIN_ID.pipe"
SOURCE_PID=""
TRANSFORM_PID=""
SUBMIT_PID=""
SLEEP_PID=""
SIGNER_PID=""
QUEUED_PID=""

wait_for_socket() {
  local name=$1 pid=$2 path=$3
  for _ in {1..200}; do
    [[ -S "$path" ]] && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.05
  done
  echo "{\"level\":\"error\",\"event\":\"$name.timeout\",\"socket\":\"$path\"}" >&2
  return 1
}

stop_pipeline() {
  for pid in "$SOURCE_PID" "$TRANSFORM_PID" "$SUBMIT_PID"; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "$SOURCE_PID" "$TRANSFORM_PID" "$SUBMIT_PID"; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
  SOURCE_PID=""
  TRANSFORM_PID=""
  SUBMIT_PID=""
  rm -f "$POSITIONS_PIPE" "$TRANSACTIONS_PIPE"
}

stop_children() {
  stop_pipeline
  if [[ -n "$SLEEP_PID" ]]; then
    kill -TERM "$SLEEP_PID" 2>/dev/null || true
    wait "$SLEEP_PID" 2>/dev/null || true
  fi
  if [[ -n "$QUEUED_PID" ]]; then
    kill -TERM "$QUEUED_PID" 2>/dev/null || true
    wait "$QUEUED_PID" 2>/dev/null || true
  fi
  if [[ -n "$SIGNER_PID" ]]; then
    kill -TERM "$SIGNER_PID" 2>/dev/null || true
    wait "$SIGNER_PID" 2>/dev/null || true
  fi
}

shutdown() {
  trap - SIGTERM SIGINT
  stop_children
  exit 0
}
trap shutdown SIGTERM SIGINT

if ! is_dry_run; then
  bun "$SIGNER" &
  SIGNER_PID=$!
  wait_for_socket signer "$SIGNER_PID" "$SIGNER_SOCKET" || {
    wait "$SIGNER_PID" 2>/dev/null || true
    exit 1
  }
  unset SIGNER_PRIVATE_KEY
fi

bun "$QUEUED" serve --chain "$CHAIN_ID" &
QUEUED_PID=$!
wait_for_socket queued "$QUEUED_PID" "$QUEUED_SOCKET" || {
  if [[ -n "$SIGNER_PID" ]]; then
    kill -TERM "$SIGNER_PID" 2>/dev/null || true
    wait "$SIGNER_PID" 2>/dev/null || true
  fi
  wait "$QUEUED_PID" 2>/dev/null || true
  exit 1
}

echo "{\"level\":\"info\",\"event\":\"loop.start\",\"bot\":\"$BOT\",\"chainId\":\"$CHAIN_ID\"}" >&2
while { [[ -z "$SIGNER_PID" ]] || kill -0 "$SIGNER_PID" 2>/dev/null; } && kill -0 "$QUEUED_PID" 2>/dev/null; do
  rm -f "$POSITIONS_PIPE" "$TRANSACTIONS_PIPE"
  mkfifo "$POSITIONS_PIPE" "$TRANSACTIONS_PIPE"

  bun "$CLI" "$BOT" "${SOURCE_OP:-unhealthy-positions}" >"$POSITIONS_PIPE" &
  SOURCE_PID=$!
  bun "$CLI" "$BOT" "${TRANSFORM_OP:-liquidate}" <"$POSITIONS_PIPE" >"$TRANSACTIONS_PIPE" &
  TRANSFORM_PID=$!
  bun "$QUEUED" submit --chain "$CHAIN_ID" <"$TRANSACTIONS_PIPE" &
  SUBMIT_PID=$!

  codes=()
  wait "$SOURCE_PID"; codes+=("$?"); SOURCE_PID=""
  wait "$TRANSFORM_PID"; codes+=("$?"); TRANSFORM_PID=""
  wait "$SUBMIT_PID"; codes+=("$?"); SUBMIT_PID=""
  rm -f "$POSITIONS_PIPE" "$TRANSACTIONS_PIPE"
  if [[ " ${codes[*]} " == *" 2 "* ]]; then
    echo "{\"level\":\"error\",\"event\":\"loop.fatal\",\"codes\":\"${codes[*]}\"}" >&2
    stop_children
    exit 2
  fi
  sleep "${TICK_INTERVAL_S:-2}" &
  SLEEP_PID=$!
  wait "$SLEEP_PID"
  SLEEP_PID=""
done

echo '{"level":"error","event":"runtime.exited","detail":"runtime service stopped"}' >&2
stop_children
exit 1
