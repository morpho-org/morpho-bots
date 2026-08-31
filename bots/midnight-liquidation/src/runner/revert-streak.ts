import type { Hex } from 'viem'

/**
 * How long an unbroken execution-revert streak may run before {@link RevertStreak.escalate} reports it.
 *
 * A DURATION rather than an attempt count, because post-maturity LIF ramps on wall-clock: a position
 * becomes fundable at a moment, not after N tries, and attempts-to-clear is `clearing_time /
 * sweep_period` — the sweep period being exactly what shrinks as the bot gets faster. A count
 * threshold would need recalibrating on every latency win and would start firing on healthy positions.
 * 15 minutes sits past the 4–9 minutes positions actually took to clear on 2026-08-28 and well inside
 * the 60-minute ramp ({@link TIME_TO_MAX_LIF}).
 */
export const REVERT_STREAK_ESCALATE_MS = 15 * 60_000

/** What {@link RevertStreakStore.record} learned about the streak the just-recorded revert extends. */
export type RevertStreak = {
  /** Consecutive execution-reverted sends, this one included. */
  count: number
  /** Wall-clock ms from the streak's FIRST execution-reverted send to this one; `0` on the first. */
  durationMs: number
  /** The 4-byte selector this send reverted with, absent when the payload carried none. */
  selector: Hex | undefined
  /**
   * True while every send in the streak reported the same selector — much stronger evidence of a
   * structural fault (a closed gate, malformed calldata, an estimator discrepancy) than a mixed
   * streak, which reads as ordinary min-out shortfalls against whichever pool the route hit.
   */
  selectorConstant: boolean
  /** The streak has run longer than the store's threshold — see {@link REVERT_STREAK_ESCALATE_MS}. */
  escalate: boolean
}

/**
 * Per-position tracker of consecutive execution-reverted sends, keyed by the `${id}:${borrower}`
 * label. The backstop that makes running an execution-reverted send with NO retry throttle
 * defensible: a min-out shortfall clears as the LIF ramps, but a persistent estimator-only failure —
 * an expired route deadline, malformed aggregator calldata, a gate that keeps closing — passes
 * `eth_call` at `latest` and fails `eth_estimateGas` against pending state indefinitely, which would
 * otherwise burn quotes forever without progressing. It only reports; it never suppresses.
 *
 * In-memory only, like {@link Backoff} and {@link CooldownStore} — chain truth wins on restart.
 */
export type RevertStreakStore = {
  /** Extends `label`'s streak with one execution-reverted send and returns its state. */
  record: (label: string, selector?: Hex) => RevertStreak
  /** Ends `label`'s streak — a broadcast, or a send failure the chain did not decline. */
  reset: (label: string) => void
}

type Entry = { count: number; startedAt: number; selector: Hex | undefined; constant: boolean }

export const createRevertStreakStore = (
  opts: { escalateAfterMs?: number; now?: () => number } = {}
): RevertStreakStore => {
  const escalateAfterMs = opts.escalateAfterMs ?? REVERT_STREAK_ESCALATE_MS
  const now = opts.now ?? (() => Date.now())
  const streaks = new Map<string, Entry>()

  return {
    record: (label, selector) => {
      const at = now()
      const previous = streaks.get(label)
      const entry: Entry = previous
        ? {
            count: previous.count + 1,
            startedAt: previous.startedAt,
            selector,
            constant: previous.constant && previous.selector === selector
          }
        : { count: 1, startedAt: at, selector, constant: true }
      streaks.set(label, entry)
      const durationMs = at - entry.startedAt
      return {
        count: entry.count,
        durationMs,
        selector,
        selectorConstant: entry.constant,
        escalate: durationMs > escalateAfterMs
      }
    },
    reset: label => {
      streaks.delete(label)
    }
  }
}
