/**
 * Block-height cadence gate: the returned predicate is true at most once per `everyBlocks`, in O(1)
 * state. The first call always grants; a later call grants once `block` is at least `everyBlocks`
 * past the last GRANT (not the last call), and stamps the cadence when it does.
 *
 * @param everyBlocks - Minimum block distance between grants. `0n` grants every call.
 * @returns A predicate holding one block height — construct one per call site and keep it for the
 *   process lifetime.
 */
export const createBlockSampler = (everyBlocks: bigint) => {
  let lastAt: bigint | null = null
  return (block: bigint): boolean => {
    if (lastAt !== null && block - lastAt < everyBlocks) return false
    lastAt = block
    return true
  }
}
