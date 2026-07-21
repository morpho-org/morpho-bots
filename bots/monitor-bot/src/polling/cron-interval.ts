// Translate a fixed polling interval (whole seconds) into a 6-field cron expression the scheduler
// engine (`cron`, driven by `PollerRegistrar`) understands — the seconds-first format, e.g.
// `*/30 * * * * *`. This is the sole cadence knob: `POLL_INTERVAL_SECONDS` drives every poller.
//
// Only intervals that yield a genuinely periodic schedule are accepted. A cron step field (`*/N`)
// silently *drifts* whenever N does not divide its unit: `*/45` in the seconds field fires at :00
// and :45 — a 45s/15s sawtooth, not "every 45 seconds". Rejecting those fail-loud (the repo's
// convention) keeps the `POLL_INTERVAL_SECONDS` promise honest instead of scheduling a lie.
//
// Accepted:
// - sub-minute: any divisor of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30) -> `*/N * * * * *`
// - exactly a minute: 60 -> `0 * * * * *`
// - whole minutes whose minute count divides 60 (120, 180, ... 1800) -> `0 */M * * * *`
export function intervalToCron(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`POLL_INTERVAL_SECONDS must be a positive integer, got ${seconds}`)
  }
  if (seconds < 60) {
    if (60 % seconds !== 0) {
      throw new Error(
        `POLL_INTERVAL_SECONDS=${seconds} would drift within each minute; use a divisor of 60 ` +
          `(1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30) or a whole-minute multiple`
      )
    }
    return `*/${seconds} * * * * *`
  }
  if (seconds % 60 !== 0) {
    throw new Error(
      `POLL_INTERVAL_SECONDS=${seconds} is over a minute but not a whole-minute multiple; ` +
        `use a multiple of 60`
    )
  }
  const minutes = seconds / 60
  if (minutes === 1) return '0 * * * * *'
  if (60 % minutes !== 0) {
    throw new Error(
      `POLL_INTERVAL_SECONDS=${seconds} (${minutes}m) would drift across the hour; use a ` +
        `minute count that divides 60 (2, 3, 4, 5, 6, 10, 12, 15, 20, 30)`
    )
  }
  return `0 */${minutes} * * * *`
}
