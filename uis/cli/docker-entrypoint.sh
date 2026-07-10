#!/bin/sh
# The prod persistence loop around the one-shot CLI: run `morpho-bots $BOT tick` every
# TICK_INTERVAL_S seconds (default 2 ≈ Base block time — the stuck-tx / cooldown block math assumes
# roughly per-block ticks). Exit-code contract (see uis/cli/src/commands/tick.ts):
#   0 tick done or lock-skip → keep looping
#   1 transient tick error   → keep looping (the next tick retries; sleep bounds the rate)
#   2 config/usage error     → EXIT the loop. Retrying can't fix an operator error, and a silent
#                              2-second crash-loop is the worst failure mode — crash the container
#                              visibly so the platform (Railway) surfaces it.
set -u

: "${BOT:?BOT must be set to 'blue' or 'midnight'}"
export MORPHO_BOTS_HOME="${MORPHO_BOTS_HOME:-/data/morpho-bots}"
mkdir -p "$MORPHO_BOTS_HOME"

echo "{\"level\":\"info\",\"event\":\"loop.start\",\"bot\":\"$BOT\",\"intervalS\":\"${TICK_INTERVAL_S:-2}\",\"home\":\"$MORPHO_BOTS_HOME\"}"
while true; do
  bun src/main.ts "$BOT" tick
  code=$?
  if [ "$code" -eq 2 ]; then
    echo "{\"level\":\"error\",\"event\":\"loop.fatal\",\"bot\":\"$BOT\",\"detail\":\"config/usage error (exit 2) — stopping the loop; fix config and redeploy\"}" >&2
    exit 2
  fi
  sleep "${TICK_INTERVAL_S:-2}"
done
