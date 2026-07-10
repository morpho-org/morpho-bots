#!/bin/bash
# The prod persistence loop around the one-shot CLI. Each tick is the three-stage UNIX pipeline
#   bun dist/main.js $BOT $SOURCE_OP | bun dist/main.js $BOT $TRANSFORM_OP | bun dist/main.js $BOT queue
# where SOURCE_OP/TRANSFORM_OP default to the liquidation pair (unhealthy-positions | liquidate) and
# can be overridden to run a different behavior (which ops run is deployment policy — a new op in a
# core cannot silently change what prod runs). Runs every TICK_INTERVAL_S seconds (default 2 ≈ Base
# block time — the stuck-tx / cooldown block math assumes roughly per-block ticks). `bash` (not `sh`)
# is required for PIPESTATUS: a plain pipe reports only the LAST stage's code and `pipefail` only the
# aggregate, but we need EACH stage's.
#
# Data plane vs. log plane: stdout carries JSON-Lines records (source → opportunity, transform → tx +
# outcome, queue → outcome). The queue's outcome lines are the tail of the pipe, so they land in the
# container's stdout logs; everything a human reads (stage summaries, warnings, errors) goes to
# STDERR. This script's own lifecycle lines (loop.start/loop.fatal) are stderr too.
#
# Per-stage exit-code contract (each stage honors it independently; see
# interfaces/cli/src/commands/*.ts):
#   0 stage done or lock-skip → keep looping
#   1 transient stage error   → keep looping (the next tick retries; sleep bounds the rate)
#   2 config/usage/wire error → EXIT the loop. Retrying can't fix an operator error, and a silent
#                               2-second crash-loop is the worst failure mode — crash the container
#                               visibly so the platform (Railway) surfaces it.
# We inspect PIPESTATUS after each pipeline: ANY stage exiting 2 → loop.fatal + exit 2; any other
# nonzero is transient → sleep and re-loop. Per-tx failures are outcome records, not exit codes, so
# exit 1 keeps its meaning ("the stage didn't run"). No `timeout` wrapper — per-stage RPC/HTTP
# timeouts already bound a hung stage, and keeping the loop simple beats a coarse pipeline timeout.
set -u

: "${BOT:?BOT must be set to 'blue' or 'midnight'}"
export MORPHO_BOTS_HOME="${MORPHO_BOTS_HOME:-/data/morpho-bots}"
mkdir -p "$MORPHO_BOTS_HOME"

# Run from the CLI package so `bun dist/main.js` resolves regardless of the image's WORKDIR (this
# script lives in bots/, a sibling of interfaces/ under the repo root). dist/main.js is the AOT
# bundle the Dockerfile builds — the lens bytecode is baked in, so spawns pay no soltag/solc cost.
cd "$(dirname "$0")/../interfaces/cli" || exit 2

echo "{\"level\":\"info\",\"event\":\"loop.start\",\"bot\":\"$BOT\",\"sourceOp\":\"${SOURCE_OP:-unhealthy-positions}\",\"transformOp\":\"${TRANSFORM_OP:-liquidate}\",\"intervalS\":\"${TICK_INTERVAL_S:-2}\",\"home\":\"$MORPHO_BOTS_HOME\"}" >&2
while true; do
  bun dist/main.js "$BOT" "${SOURCE_OP:-unhealthy-positions}" | bun dist/main.js "$BOT" "${TRANSFORM_OP:-liquidate}" | bun dist/main.js "$BOT" queue
  codes=("${PIPESTATUS[@]}")
  if [[ " ${codes[*]} " == *" 2 "* ]]; then
    echo "{\"level\":\"error\",\"event\":\"loop.fatal\",\"bot\":\"$BOT\",\"codes\":\"${codes[*]}\",\"detail\":\"a pipeline stage exited 2 (config/usage/wire error) — stopping the loop; fix config and redeploy\"}" >&2
    exit 2
  fi
  sleep "${TICK_INTERVAL_S:-2}"
done
