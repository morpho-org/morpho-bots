/** The bootstrap's cadence: how often its references are read, and its markets polled without a ladder. */
export const BOOTSTRAP_MONITOR_INTERVAL_MS = 60_000

/**
 * How often the world is polled, and so every market decided: the fastest ladder cadence, capped at
 * the bootstrap's.
 * @param ladder - Each ladder market's configured loop interval.
 * @returns The poll interval in milliseconds; the bootstrap cadence when no ladder is configured.
 */
export const quoterPollMs = (ladder: readonly { loopIntervalSeconds: number }[]) =>
  Math.min(...ladder.map(item => 1_000 * item.loopIntervalSeconds), BOOTSTRAP_MONITOR_INTERVAL_MS)
