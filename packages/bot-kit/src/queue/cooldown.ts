/**
 * Opt-in per-position liquidation cooldown, keyed by the `${id}:${borrower}` label. A COMPLEMENTARY
 * rate-limit defense to {@link Backoff}, not a replacement: after a liquidation attempt fails to
 * produce a submittable transaction (no swap route, quote failure, or sim revert), the caller
 * {@link CooldownStore.mark}s the position and {@link CooldownStore.shouldSkip} suppresses re-quoting
 * the rate-limited venue APIs for a fixed `cooldownMs` window. Unlike {@link Backoff}'s block-based
 * exponential growth, this is a flat wall-clock window and is DISABLED by default — an operator opts
 * in to throttle a specific class of persistently-failing positions on a rate-limited venue.
 *
 * Successful attempts are never marked — a landed position clears from discovery and a dropped one
 * retries next tick. `cooldownMs <= 0` disables the store entirely: `shouldSkip` is always `false`
 * and `mark` is a no-op, so an opted-out deployment behaves exactly as before with no branching at
 * the call site.
 *
 * In-memory only — one store built at composition time and held for the process lifetime. Like the
 * pending queue and {@link Backoff}, chain truth wins on restart, so there is nothing to persist: a
 * position still liquidatable after a restart is simply re-attempted (and, if it still fails,
 * re-marked). Entries for positions that recover to non-liquidatable are never re-checked and linger
 * until process exit — an accepted, bounded leak (the liquidatable set is small).
 */
export type CooldownStore = {
  /** True if `label` was marked within the cooldown window and should be skipped this tick. */
  shouldSkip: (label: string) => boolean
  /** Record that `label` just failed to produce a submittable tx (starts/refreshes its cooldown). */
  mark: (label: string) => void
}

export function createCooldownStore(opts: {
  cooldownMs: number
  now?: () => number
}): CooldownStore {
  const { cooldownMs } = opts
  const now = opts.now ?? (() => Date.now())
  const enabled = cooldownMs > 0
  const attemptedAt = new Map<string, number>()

  return {
    shouldSkip: label => {
      if (!enabled) return false
      const at = attemptedAt.get(label)
      return at !== undefined && now() - at < cooldownMs
    },
    mark: label => {
      if (!enabled) return
      attemptedAt.set(label, now())
    }
  }
}
