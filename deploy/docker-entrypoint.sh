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
CLI="${CLI_BIN:-$REPO_ROOT/apps/cli/dist/main.js}"
QUEUED="${QUEUED_BIN:-$REPO_ROOT/apps/queued/dist/main.js}"
SIGNER="${SIGNER_BIN:-$REPO_ROOT/apps/signer/src/main.ts}"
VECTOR="${VECTOR_BIN:-/usr/bin/vector}"
VECTOR_CONFIG="${VECTOR_CONFIG:-$REPO_ROOT/deploy/vector.yaml}"
export QUEUED_SOCKET="${QUEUED_SOCKET:-$MORPHO_BOTS_HOME/queued-$CHAIN_ID.sock}"
POSITIONS_PIPE="$MORPHO_BOTS_HOME/positions-$CHAIN_ID.pipe"
TRANSACTIONS_PIPE="$MORPHO_BOTS_HOME/transactions-$CHAIN_ID.pipe"
SOURCE_PID=""
TRANSFORM_PID=""
SUBMIT_PID=""
SLEEP_PID=""
SIGNER_PID=""
QUEUED_PID=""
VECTOR_PID=""
SPOOL_ROTATE_PID=""

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

# Bound a graceful stop: SIGTERM was already sent; poll up to `timeout` seconds, then SIGKILL. Keeps a
# slow child (the log shipper) from eating into the platform's stop_grace_period and starving the
# queue's drain window.
stop_within() {
  local pid=$1 timeout=$2 i
  for ((i = 0; i < timeout * 10; i++)); do
    kill -0 "$pid" 2>/dev/null || {
      wait "$pid" 2>/dev/null || true
      return 0
    }
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# Keep the ephemeral log spool bounded: truncate in place past the cap. Vector detects the truncation
# via its data_dir checkpoint; minor dup/loss on rotation is acceptable since the real stderr is the
# source of truth.
rotate_spool() {
  local cap="${BOT_LOG_SPOOL_MAX_BYTES:-52428800}"
  while true; do
    sleep "${BOT_LOG_SPOOL_ROTATE_S:-60}"
    [[ -f "$BOT_LOG_SPOOL" ]] || continue
    # `wc -c` is portable (GNU + BSD); `stat` flags differ across the two.
    if (($(wc -c <"$BOT_LOG_SPOOL" 2>/dev/null || echo 0) > cap)); then : >"$BOT_LOG_SPOOL"; fi
  done
}

# Optional BetterStack forwarding. Fans ALL stderr to BOTH the real stderr (Railway's native explorer,
# unchanged) and an ephemeral spool a Vector side-car tails and ships to a per-bot BetterStack source.
# No-op unless BETTERSTACK_SOURCE_TOKEN is set, so the default container behaves exactly as before.
start_log_forwarder() {
  [[ -n "${BETTERSTACK_SOURCE_TOKEN:-}" ]] || return 0
  if [[ -z "${BETTERSTACK_INGESTING_HOST:-}" ]]; then
    echo '{"level":"error","event":"logforward.misconfigured","detail":"BETTERSTACK_SOURCE_TOKEN set without BETTERSTACK_INGESTING_HOST; not forwarding"}' >&2
    return 0
  fi
  local dir="${BOT_LOG_SPOOL_DIR:-/tmp/morpho-bots-logs}"
  export BOT_LOG_SPOOL="${BOT_LOG_SPOOL:-$dir/spool.log}"
  export VECTOR_DATA_DIR="${VECTOR_DATA_DIR:-$dir/vector}"
  mkdir -p "$dir" "$VECTOR_DATA_DIR"
  : >"$BOT_LOG_SPOOL"
  # Preserve the real stderr on fd 3 so Vector's OWN logs bypass the spool it tails — otherwise its
  # retry errors during a BetterStack outage would be re-read and re-shipped, a self-amplifying loop.
  exec 3>&2
  # tee targets a local ephemeral file, so the shipper can never block the bot; the spool stays off
  # /data so it can't fill the state/journal volume, and rotate_spool bounds its growth.
  exec 2> >(tee -a "$BOT_LOG_SPOOL" >&2)
  # Belt-and-suspenders on top of the ambient unset above: the shipper never holds the signing key.
  env -u SIGNER_PRIVATE_KEY "$VECTOR" --config "$VECTOR_CONFIG" 2>&3 &
  VECTOR_PID=$!
  rotate_spool &
  SPOOL_ROTATE_PID=$!
  echo "{\"level\":\"info\",\"event\":\"logforward.start\",\"spool\":\"$BOT_LOG_SPOOL\"}" >&2
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
  # The log shipper stops LAST so it can flush the teardown lines above, with a bounded wait.
  if [[ -n "$SPOOL_ROTATE_PID" ]]; then
    kill -TERM "$SPOOL_ROTATE_PID" 2>/dev/null || true
    wait "$SPOOL_ROTATE_PID" 2>/dev/null || true
  fi
  if [[ -n "$VECTOR_PID" ]]; then
    kill -TERM "$VECTOR_PID" 2>/dev/null || true
    stop_within "$VECTOR_PID" "${VECTOR_STOP_TIMEOUT_S:-5}"
  fi
}

shutdown() {
  trap - SIGTERM SIGINT
  stop_children
  exit 0
}
trap shutdown SIGTERM SIGINT

# Hold the signing key out of the ambient environment before forking ANY helper (log shipper, tee,
# rotation, queue) so only the signer process below ever receives it — the single-key-reader
# invariant, enforced for every child rather than just Vector.
SIGNER_KEY_HELD="${SIGNER_PRIVATE_KEY:-}"
unset SIGNER_PRIVATE_KEY

# Start the log shipper before the signer/queue so their startup lines are forwarded too.
start_log_forwarder

if ! is_dry_run; then
  SIGNER_PRIVATE_KEY="$SIGNER_KEY_HELD" bun "$SIGNER" &
  SIGNER_PID=$!
  wait_for_socket signer "$SIGNER_PID" "$SIGNER_SOCKET" || {
    wait "$SIGNER_PID" 2>/dev/null || true
    exit 1
  }
fi
unset SIGNER_KEY_HELD

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
