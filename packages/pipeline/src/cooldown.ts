/**
 * Restorable per-position cooldown for the `liquidate` transform's backoff-on-failure policy: what
 * `dump()` emits and `initial` accepts. Each entry is `[positionId, attemptedAtMs]`; survives a
 * bigint-safe JSON round-trip (all numbers). Keyed by the wire position `id`, which the source
 * derives deterministically every tick, so an entry restored from the disposable op cache matches
 * the same position on the next tick.
 */
export type CooldownEntries = [id: string, attemptedAtMs: number][]

export type CooldownStore = {
  /** True if `id` was attempted within the cooldown window and should be skipped this tick. */
  shouldSkip: (id: string) => boolean
  /** Record that `id` was just attempted (starts/refreshes its cooldown). */
  mark: (id: string) => void
  /** Restorable snapshot with expired entries pruned, for the CLI to persist. */
  dump: () => CooldownEntries
}

/**
 * A per-position "attempted-at" store implementing failure backoff: after a liquidation attempt on a
 * position fails to produce a submittable transaction, the caller {@link CooldownStore.mark}s it and
 * skips it via {@link CooldownStore.shouldSkip} until `cooldownMs` elapses — so a persistently-failing
 * position stops re-hitting the rate-limited venue APIs every tick. Successful attempts are never
 * marked (a landed position clears from discovery; a dropped one retries next tick).
 *
 * `cooldownMs <= 0` disables the store entirely: `shouldSkip` is always `false`, `mark` is a no-op,
 * and `dump()` returns `[]` — so callers need no branching and a disabled deployment persists nothing.
 *
 * The cache lives in this closure (one store per process); mirror of `createVenueSelector`'s idiom —
 * injected `now` for deterministic tests, `dump()`/`initial` for the op disposable-cache round-trip.
 */
export function createCooldownStore(opts: {
  cooldownMs: number
  now?: () => number
  initial?: CooldownEntries
}): CooldownStore {
  const { cooldownMs } = opts
  const now = opts.now ?? (() => Date.now())
  const enabled = cooldownMs > 0
  // Seed even when disabled is cheap, but skip it so a disabled store holds nothing to dump.
  const attemptedAt = new Map<string, number>(enabled ? (opts.initial ?? []) : [])

  return {
    shouldSkip: id => {
      if (!enabled) return false
      const at = attemptedAt.get(id)
      return at !== undefined && now() - at < cooldownMs
    },
    mark: id => {
      if (!enabled) return
      attemptedAt.set(id, now())
    },
    dump: () => {
      if (!enabled) return []
      const cutoff = now()
      const out: CooldownEntries = []
      // Prune expired entries so the persisted file stays bounded to positions failed within the
      // last window — unlike an immutable-key cache, cooldown entries are only relevant while active.
      for (const [id, at] of attemptedAt) {
        if (cutoff - at < cooldownMs) out.push([id, at])
      }
      return out
    }
  }
}
