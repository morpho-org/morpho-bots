#!/bin/bash
# Entrypoint for the midnight-liquidation bot with an OPTIONAL BetterStack log-forwarding side-car.
#
# The bot (`bun run start`, one long-running process) emits ALL JSON log lines — every level — to
# stderr (@repo/bot-kit's createLogger; stdout stays reserved for program output). This wrapper fans
# stderr to (a) the real stderr — so Railway's native explorer and `railway logs` are byte-identical
# to today — and (b) a bounded spool file on ephemeral storage that an optional Vector side-car
# tails and ships to the per-bot BetterStack HTTP source. One stream, one tee: log capture cannot
# silently miss a level, and anything else that reaches stderr (crash traces, runtime errors) ships
# with it.
#
# Opt-in: Vector starts ONLY when BETTERSTACK_SOURCE_TOKEN is set (BETTERSTACK_INGESTING_HOST also
# required; token-without-host fails loud and skips forwarding). Unset => byte-identical to today.
# The shipper is off the critical path — a slow/dead Vector or unreachable BetterStack never blocks
# the bot, and the HTTP sink drops newest rather than backpressuring. LIQUIDATOR_PRIVATE_KEY is
# scrubbed from Vector's environment (`env -u`) so the shipper never sees the signing key.
set -u

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VECTOR="${VECTOR_BIN:-/usr/bin/vector}"
VECTOR_CONFIG="${VECTOR_CONFIG:-$BOT_DIR/vector.yaml}"

# Keep the ephemeral spool bounded: truncate in place past the cap. Vector detects the truncation via
# its data_dir checkpoint; minor dup/loss on rotation is acceptable since the real stdout/stderr is
# the source of truth.
rotate_spool() {
  local cap="${BOT_LOG_SPOOL_MAX_BYTES:-52428800}"
  while true; do
    sleep "${BOT_LOG_SPOOL_ROTATE_S:-60}"
    [[ -f "$BOT_LOG_SPOOL" ]] || continue
    # `wc -c` is portable (GNU + BSD); `stat` flags differ across the two.
    if (($(wc -c <"$BOT_LOG_SPOOL" 2>/dev/null || echo 0) > cap)); then : >"$BOT_LOG_SPOOL"; fi
  done
}

# Optional BetterStack forwarding. No-op unless BETTERSTACK_SOURCE_TOKEN is set, so the default
# container behaves exactly as before.
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
  # Fan the bot's stderr (the sole log stream) to the ephemeral spool AND its real destination.
  # tee targets a local ephemeral file, so the shipper can never block the bot; the spool stays off
  # any persistent volume so it can't fill the disk that holds queue state, and rotate_spool bounds
  # it. stdout passes through untouched.
  exec 2> >(tee -a "$BOT_LOG_SPOOL" >&2)
  # `env -u` keeps the signing key out of the shipper. VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION
  # re-enables the ${...} interpolation vector.yaml relies on, which Vector disabled by default in
  # 0.57 — safe here since the config is baked read-only and the interpolated vars are operator-set
  # (Railway/compose), not attacker-controlled. Vector's own stderr goes to fd 3 (bypassing the spool).
  env -u LIQUIDATOR_PRIVATE_KEY VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true \
    "$VECTOR" --config "$VECTOR_CONFIG" 2>&3 &
  rotate_spool &
  echo "{\"level\":\"info\",\"event\":\"logforward.start\",\"spool\":\"$BOT_LOG_SPOOL\"}" >&2
}

start_log_forwarder

# Hand off to the bot as PID 1. The tee redirections persist across exec; Vector and the rotate loop
# run as background children reparented to the bot. The shipper is intentionally not gracefully
# drained on shutdown — the real stdout/stderr is the source of truth and a few buffered lines may be
# lost on stop, matching the "off the critical path" design.
cd "$BOT_DIR"
exec bun run start
