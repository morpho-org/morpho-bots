import type { Hex } from 'viem'

/**
 * How long an unbroken execution-revert streak may run before {@link RevertStreak.escalate} reports it.
 *
 * A DURATION rather than an attempt count, because post-maturity LIF ramps on wall-clock: a position
 * becomes fundable at a moment, not after N tries, and attempts-to-clear is `clearing_time /
 * sweep_period` — the sweep period being exactly what shrinks as the bot gets faster. A count
 * threshold would need recalibrating on every latency win and would start firing on healthy positions.
 * 15 minutes sits past the 4–9 minutes positions actually took to clear on 2026-08-28 and well inside
 * the 60-minute `TIME_TO_MAX_LIF` ramp.
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
  /**
   * Where this revert sits against the store's threshold ({@link REVERT_STREAK_ESCALATE_MS}):
   * `crossed` on the one revert that first runs past it, `ongoing` on every revert after that. A
   * reporter must fire on `crossed` alone — `ongoing` repeats for as long as the position stays
   * stuck, which on a per-block sweep is unbounded.
   */
  escalate: 'below' | 'crossed' | 'ongoing'
}

/**
 * Per-position tracker of consecutive execution-reverted sends, keyed by the `${id}:${borrower}`
 * label. The backstop that makes running an execution-reverted send with NO retry throttle
 * defensible: a min-out shortfall clears as the LIF ramps, but a persistent estimator-only failure —
 * an expired route deadline, malformed aggregator calldata, a gate that keeps closing — can pass the
 * simulation and fail the send's gas estimate indefinitely, which would otherwise burn quotes forever
 * without progressing. Both calls run at `latest`; they diverge because they are issued by DIFFERENT
 * clients over their own `failover` transport pairs, so they can observe different heads, different
 * provider-side estimator behaviour, and pool state that moved in between. It only reports; it never
 * suppresses.
 *
 * In-memory only, like the shared `Backoff` and `CooldownStore` — chain truth wins on restart. Entries
 * for a position that recovers to non-liquidatable are never re-checked and linger until process exit:
 * the same accepted, bounded leak `createBackoff` documents at its canonical home.
 */
export type RevertStreakStore = {
  /** Extends `label`'s streak with one execution-reverted send and returns its state. */
  record: (label: string, selector?: Hex) => RevertStreak
  /** Ends `label`'s streak — a broadcast, or a send failure the chain did not decline. */
  reset: (label: string) => void
}

type Entry = {
  count: number
  startedAt: number
  selector: Hex | undefined
  constant: boolean
  escalated: boolean
}

/**
 * Lives in this bot rather than `@repo/bot-kit` because the threshold is calibrated against one bot's
 * incentive shape — a wall-clock LIF ramp — and no second consumer exists yet.
 */
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
      const count = (previous?.count ?? 0) + 1
      const startedAt = previous?.startedAt ?? at
      const constant = previous ? previous.constant && previous.selector === selector : true
      const durationMs = at - startedAt
      const past = durationMs > escalateAfterMs
      streaks.set(label, { count, startedAt, selector, constant, escalated: past })
      return {
        count,
        durationMs,
        selector,
        selectorConstant: constant,
        escalate: past ? (previous?.escalated ? 'ongoing' : 'crossed') : 'below'
      }
    },
    reset: label => {
      streaks.delete(label)
    }
  }
}
