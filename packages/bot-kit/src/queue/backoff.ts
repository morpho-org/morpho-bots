/**
 * Per-position exponential backoff, keyed by the `${id}:${borrower}` label. The primary API
 * rate-limit defense: a position that repeatedly fails to quote or simulate (illiquid pair, no route,
 * a persistent bad-debt edge case) stops being re-quoted/re-simulated every block, so API and RPC
 * usage stay bounded even under a backlog. In-memory only — like the pending queue, chain truth wins
 * on restart, so there is nothing to persist.
 */
export type Backoff = {
  /** True if the position is currently backed off (recorded a failure and the cooldown hasn't elapsed). */
  shouldSkip: (label: string, block: bigint) => boolean
  /** Record a failure at `block`; the next attempt is allowed after an exponentially growing delay. */
  record: (label: string, block: bigint) => void
  /**
   * Clear the position's backoff. Call ONLY on a real broadcast — a `submit` that returned without
   * sending must `record` instead. Clearing deletes the accumulated attempt count, so clearing on a
   * non-broadcast resets the delay to `baseBlocks` and the exponential growth never accrues.
   */
  clear: (label: string) => void
  /** Number of positions currently tracked. */
  readonly size: number
}

/** Cap the exponent so the shift can't blow up for a chronically failing position. */
const MAX_SHIFT = 32

export function createBackoff(opts: { baseBlocks: bigint; maxBlocks: bigint }): Backoff {
  const { baseBlocks, maxBlocks } = opts
  const entries = new Map<string, { attempts: number; until: bigint }>()

  return {
    // We deliberately do NOT evict on expiry here: the attempt count must survive past the cooldown
    // so a chronically failing position keeps backing off exponentially (evicting would reset it to
    // attempt 1 every cooldown). A position that fails then recovers to non-liquidatable is never
    // re-checked, so its entry lingers until process exit — an accepted, bounded leak for v0 (the
    // liquidatable set is small); `clear` on a successful submit is the main eviction path.
    shouldSkip(label, block) {
      const entry = entries.get(label)
      return entry !== undefined && block < entry.until
    },
    record(label, block) {
      const attempts = (entries.get(label)?.attempts ?? 0) + 1
      const shift = BigInt(Math.min(attempts - 1, MAX_SHIFT))
      const wait = baseBlocks << shift
      entries.set(label, { attempts, until: block + (wait < maxBlocks ? wait : maxBlocks) })
    },
    clear(label) {
      entries.delete(label)
    },
    get size() {
      return entries.size
    }
  }
}
