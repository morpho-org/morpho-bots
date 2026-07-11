#!/bin/bash
# The prod supervisor around TWO processes: (1) the per-chain `queued` transaction-queue daemon and
# (2) the three-stage op-pipeline loop that feeds it. A bot needs BOTH — the pipe loop discovers and
# submits, the daemon owns settlement.
#
# Pipeline (foreground loop, one tick per TICK_INTERVAL_S seconds):
#   bun dist/main.js $BOT $SOURCE_OP | bun dist/main.js $BOT $TRANSFORM_OP | bun dist/main.js $BOT queue
# SOURCE_OP/TRANSFORM_OP default to the liquidation pair (unhealthy-positions | liquidate) and can be
# overridden to run a different behavior (which ops run is deployment policy — a new op in a core
# cannot silently change what prod runs). TICK_INTERVAL_S defaults to 2 ≈ Base block time (the
# stuck-tx / cooldown block math assumes roughly per-block ticks). `queue` is now a THIN CLIENT: it
# relays tx/outcome records over a Unix socket to the daemon, which owns dedupe/backoff/re-sim/fees/
# nonce/submit and continuous settlement/RBF.
#
# Daemon (background, supervised): `bun /repo/services/queued/dist/main.js --chain $CHAIN_ID`. There is
# no installed bin in the runtime image, so the path is spelled out. The supervisor restarts it on any
# transient exit (nonzero-but-not-2) after a short sleep. A daemon exit 2 is operator misconfig (bad
# config, lock held by a live pid, agent-address mismatch) that a restart cannot fix — the supervisor
# writes a fatal sentinel and stops; the pipe loop sees the sentinel on its next tick and crashes the
# container (exit 2) so the platform (Railway) surfaces it, exactly as a pipe-stage exit 2 does.
#
# `bash` (not `sh`) is required for PIPESTATUS: a plain pipe reports only the LAST stage's code and
# `pipefail` only the aggregate, but we need EACH stage's.
#
# Data plane vs. log plane: stdout carries JSON-Lines records (source → opportunity, transform → tx +
# outcome). The queue stage's stdout tail now carries only submit-path ACKs (submitted, would_submit,
# deduped_inflight, sim_reverted); the TERMINAL outcomes (confirmed/reverted/dropped) no longer reach
# the pipe — the daemon appends them to $MORPHO_BOTS_HOME/queued/outcomes-$CHAIN_ID.jsonl on the /data
# volume (`tail -f` that file to watch settlement). Everything a human reads — stage summaries,
# warnings, errors, the daemon's own logs, and this script's lifecycle lines — goes to STDERR.
#
# Per-stage exit-code contract (each stage honors it independently; see tools/cli/src/commands/*.ts):
#   0 stage done or lock-skip → keep looping
#   1 transient stage error   → keep looping (the next tick retries; sleep bounds the rate). A `queue`
#                               stage exiting 1 while the daemon is booting/restarting is transient by
#                               design — the socket is briefly absent; the loop just retries next tick.
#   2 config/usage/wire error → EXIT the loop. Retrying can't fix an operator error, and a silent
#                               2-second crash-loop is the worst failure mode — crash the container
#                               visibly so the platform (Railway) surfaces it.
# We inspect PIPESTATUS after each pipeline: ANY stage exiting 2 → loop.fatal + exit 2; any other
# nonzero is transient → sleep and re-loop. Per-tx failures are outcome records, not exit codes, so
# exit 1 keeps its meaning ("the stage didn't run"). No `timeout` wrapper — per-stage RPC/HTTP
# timeouts already bound a hung stage, and keeping the loop simple beats a coarse pipeline timeout.
set -u

: "${BOT:?BOT must be set to 'blue' or 'midnight'}"
: "${CHAIN_ID:?CHAIN_ID must be set to the chain id the queue daemon serves}"
export MORPHO_BOTS_HOME="${MORPHO_BOTS_HOME:-/data/morpho-bots}"
mkdir -p "$MORPHO_BOTS_HOME"

# This script lives in bots/, a sibling of tools/ and services/ under the repo root. Resolve the repo
# root absolutely so the daemon path holds regardless of cwd, then (below) run the pipe loop from the
# CLI package so `bun dist/main.js` resolves — same convention as before. Both dist/main.js are the
# AOT bundles the Dockerfile builds, so spawns pay no soltag/solc cost.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_MAIN="$REPO_ROOT/services/queued/dist/main.js"

# Entrypoint-owned coordination files under the state home, all cleared at startup so a prior
# container's crash never poisons a fresh boot: the fatal sentinel (daemon exited 2 → pipe loop
# crashes), the stop flag (shutdown asked the supervisor to stop restarting), the daemon pid file
# (lets the SIGTERM trap forward TERM to whichever daemon instance is currently running), and the
# tick-codes file (each tick's PIPESTATUS, written from a backgrounded subshell so the SIGTERM trap
# can interrupt the wait — see the loop). A stale pid on the /data volume would risk TERMing a
# recycled pid, so the pid file MUST be cleared here too.
FATAL_SENTINEL="$MORPHO_BOTS_HOME/queued-$CHAIN_ID.fatal"
STOP_FLAG="$MORPHO_BOTS_HOME/queued-$CHAIN_ID.stop"
DAEMON_PID_FILE="$MORPHO_BOTS_HOME/queued-$CHAIN_ID.entrypoint-pid"
CODES_FILE="$MORPHO_BOTS_HOME/queued-$CHAIN_ID.tick-codes"
rm -f "$FATAL_SENTINEL" "$STOP_FLAG" "$DAEMON_PID_FILE" "$CODES_FILE"

# Background supervisor: keep the queue daemon alive. The stop flag (set by `shutdown`) makes it stop
# restarting; misconfig (exit 2) drops a fatal sentinel and stops (the pipe loop turns that into a
# visible container crash); any other exit is transient → sleep briefly and restart. A clean 0 only
# happens on our TERM forward, at which point the stop flag is already set, so the post-`wait` check
# stops the loop and reaps the (fully drained) daemon.
supervise_daemon() {
  while true; do
    [[ -f "$STOP_FLAG" ]] && return 0
    bun "$DAEMON_MAIN" --chain "$CHAIN_ID" &
    local dpid=$!
    echo "$dpid" >"$DAEMON_PID_FILE"
    wait "$dpid"
    local code=$?
    [[ -f "$STOP_FLAG" ]] && return 0
    if [[ $code -eq 2 ]]; then
      touch "$FATAL_SENTINEL"
      echo "{\"level\":\"error\",\"event\":\"daemon.fatal\",\"chainId\":\"$CHAIN_ID\",\"code\":2,\"detail\":\"queued exited 2 (operator misconfig incl. lock held) — a restart cannot fix it; wrote fatal sentinel and stopping the supervisor\"}" >&2
      return 2
    fi
    echo "{\"level\":\"warn\",\"event\":\"daemon.restart\",\"chainId\":\"$CHAIN_ID\",\"code\":\"$code\",\"detail\":\"queued exited (transient) — restarting after a short backoff\"}" >&2
    sleep 2
  done
}

supervise_daemon &
SUPERVISOR_PID=$!

# The supervisor subshell forked above captured this shell's env (incl. LIQUIDATOR_PRIVATE_KEY), and
# every daemon respawn inherits that snapshot — so `queued` keeps seeing the key. Unset it HERE so it
# is gone from this shell's env and never leaks into any pipe-stage spawn (the thin-client `queue`
# would otherwise warn queue.key_ignored every tick).
unset LIQUIDATOR_PRIVATE_KEY

# Drain the daemon: set the stop flag so the supervisor won't restart, forward TERM to the live daemon
# (it drains, persists, unlinks its socket, exits 0), then wait for the supervisor to finish — its
# `wait` on the daemon reaps the full drain before it returns. Used by BOTH the SIGTERM handler and the
# fatal pipe-stage exit-2 branch, so a fatal stage exit also drains the daemon before the container dies.
stop_daemon() {
  touch "$STOP_FLAG"
  local dpid
  dpid="$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$dpid" ]]; then kill -TERM "$dpid" 2>/dev/null || true; fi
  wait "$SUPERVISOR_PID" 2>/dev/null || true
}

# On container stop, drain the daemon then exit 0.
shutdown() {
  trap - SIGTERM SIGINT
  echo "{\"level\":\"info\",\"event\":\"loop.shutdown\",\"bot\":\"$BOT\",\"chainId\":\"$CHAIN_ID\"}" >&2
  stop_daemon
  exit 0
}
trap shutdown SIGTERM SIGINT

# Run the pipe loop from the CLI package so `bun dist/main.js` resolves regardless of the image WORKDIR.
cd "$REPO_ROOT/tools/cli" || exit 2

echo "{\"level\":\"info\",\"event\":\"loop.start\",\"bot\":\"$BOT\",\"chainId\":\"$CHAIN_ID\",\"sourceOp\":\"${SOURCE_OP:-unhealthy-positions}\",\"transformOp\":\"${TRANSFORM_OP:-liquidate}\",\"intervalS\":\"${TICK_INTERVAL_S:-2}\",\"home\":\"$MORPHO_BOTS_HOME\"}" >&2
while true; do
  if [[ -f "$FATAL_SENTINEL" ]]; then
    echo "{\"level\":\"error\",\"event\":\"loop.fatal\",\"bot\":\"$BOT\",\"chainId\":\"$CHAIN_ID\",\"detail\":\"the queued daemon exited 2 (operator misconfig) and cannot recover — stopping the loop; fix config and redeploy\"}" >&2
    exit 2
  fi
  # Run the tick in a backgrounded subshell and `wait` on it so a SIGTERM interrupts the wait and the
  # trap fires PROMPTLY. bash defers traps until a foreground command returns, so a foreground pipeline
  # could otherwise run the whole tick before `docker stop` SIGKILLs us mid-drain. The subshell writes
  # its PIPESTATUS to $CODES_FILE, which we read back after the wait.
  rm -f "$CODES_FILE"
  ( bun dist/main.js "$BOT" "${SOURCE_OP:-unhealthy-positions}" | bun dist/main.js "$BOT" "${TRANSFORM_OP:-liquidate}" | bun dist/main.js "$BOT" queue; echo "${PIPESTATUS[*]}" >"$CODES_FILE" ) &
  wait $!
  # Killed mid-tick: SIGTERM interrupted the wait, the trap already ran shutdown() (which drained the
  # daemon) and exited. If we still reach here with a stop requested, the codes file may be
  # missing/partial — don't misread that as a pipeline result; just stop looping.
  [[ -f "$STOP_FLAG" ]] && break
  codes=()
  [[ -s "$CODES_FILE" ]] && read -r -a codes <"$CODES_FILE"
  if [[ " ${codes[*]} " == *" 2 "* ]]; then
    echo "{\"level\":\"error\",\"event\":\"loop.fatal\",\"bot\":\"$BOT\",\"codes\":\"${codes[*]}\",\"detail\":\"a pipeline stage exited 2 (config/usage/wire error) — stopping the loop; fix config and redeploy\"}" >&2
    stop_daemon
    exit 2
  fi
  # Background the inter-tick sleep and wait on it too, so the SIGTERM trap can interrupt it as well.
  sleep "${TICK_INTERVAL_S:-2}" &
  wait $!
done
