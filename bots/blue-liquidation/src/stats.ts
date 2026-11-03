/**
 * Counts since the last `tick.end`, which the dashboards chart by these names: preparations and
 * sends add as they finish, and the reporter flushes them into each world read's `tick.end`.
 */
export type TickCounters = {
  /** Pairs discovery handed the lens. */
  pairs: number
  noSwapPath: number
  quoteFailed: number
  ok: number
  reverted: number
  broadcast: number
  /** Acts the kernel refused, or whose bytes it kept home. */
  notSent: number
}

const EMPTY: TickCounters = {
  pairs: 0,
  noSwapPath: 0,
  quoteFailed: 0,
  ok: 0,
  reverted: 0,
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
