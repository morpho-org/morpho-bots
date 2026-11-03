/**
 * Counts since the last `tick.end`, which the dashboards chart by these names: preparations and
 * sends add as they finish, and the reporter flushes them into each world read's `tick.end`. Each is
 * per `(slot, mode)` candidate a preparation worked, except `pairs` and the two send counters.
 */
export type TickCounters = {
  /** Pairs discovery handed the lens, after the whitelist. */
  pairs: number
  /** Alternatives sized across the positions prepared. */
  candidates: number
  preselectSkipped: number
  noSwapPath: number
  quoteFailed: number
  /** Quoted, but the route could not cover the repay `liquidate` would pull. */
  quoteUnprofitable: number
  /** Not quoted: the alternative's oracle surplus was not positive. */
  noSurplus: number
  /** Simulated, but its expected profit could not cover its gas at the current base fee. */
  gasUnaffordable: number
  ok: number
  reverted: number
  /** Alternatives whose loan token had no USD price, so they were ordered last. */
  unpriced: number
  /** Firm venue calls the quotes reported; `firmCallsUnknown` counts quotes that reported none. */
  firmCalls: number
  firmCallsUnknown: number
  broadcast: number
  /** Acts the kernel refused, or whose bytes it kept home. */
  notSent: number
}

const EMPTY: TickCounters = {
  pairs: 0,
  candidates: 0,
  preselectSkipped: 0,
  noSwapPath: 0,
  quoteFailed: 0,
  quoteUnprofitable: 0,
  noSurplus: 0,
  gasUnaffordable: 0,
  ok: 0,
  reverted: 0,
  unpriced: 0,
  firmCalls: 0,
  firmCallsUnknown: 0,
  broadcast: 0,
  notSent: 0
}

export type TickStats = Readonly<{
  add: (counts: Partial<TickCounters>) => void
  /** The counts since the last flush, which it resets. */
  flush: () => TickCounters
}>

export const createTickStats = (): TickStats => {
  let counters = { ...EMPTY }
  return {
    add: counts => {
      for (const [name, count] of Object.entries(counts) as [keyof TickCounters, number][])
        counters[name] += count
    },
    flush: () => {
      const flushed = counters
      counters = { ...EMPTY }
      return flushed
    }
  }
}
