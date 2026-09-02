/**
 * Block-height cadence gate: lets a caller act at most once per `everyBlocks`. Bounds the log volume
 * of a condition that recurs every tick, in O(1) state — unlike a per-label map, there is nothing to
 * evict and nothing to leak.
 */
type BlockSampler = {
  /**
   * True when `block` is at least `everyBlocks` past the last granted claim; the first call always
   * grants. STAMPS the cadence on true, hence `claim` rather than a predicate name.
   *
   * A caller that asks ONLY when it has something to say therefore gets edge-triggering for free: a
   * quiet stretch never consumes the window, so the first occurrence after any gap is always reported
   * and a sustained condition settles to one report per `everyBlocks`.
   */
  claim: (block: bigint) => boolean
}

/**
 * Builds a {@link BlockSampler}.
 *
 * @param everyBlocks - Minimum block distance between granted claims. `0n` grants every call.
 * @returns A sampler holding one block height — construct one per call site and hold it for the
 *   process lifetime.
 */
export const createBlockSampler = (everyBlocks: bigint): BlockSampler => {
  let lastAt: bigint | null = null
  return {
    claim(block) {
      if (lastAt !== null && block - lastAt < everyBlocks) return false
      lastAt = block
      return true
    }
  }
}
