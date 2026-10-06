/** Block number and timestamp of one canonical block. */
export type BlockHeader = { number: bigint; timestamp: bigint }

/**
 * Locates the newest block whose timestamp is at or before a target.
 * @param parameters - Latest header, target unix timestamp, historical block reader, and the
 * chain's nominal block time used to seed the first probe.
 * @returns The block at or before the target, or `undefined` when even the genesis block is newer.
 * @remarks Assumes block timestamps strictly increase, so an exact timestamp hit is unique. Blocks
 * arriving faster than `blockTimeMs` only cost extra reads, never correctness.
 */
export const findBlockAtOrBefore = async (parameters: {
  latest: BlockHeader
  target: bigint
  getBlock: (blockNumber: bigint) => Promise<{ timestamp: bigint }>
  blockTimeMs: number
}) => {
  const { latest, target, getBlock } = parameters
  if (latest.timestamp <= target) return latest
  const blockTimeMs = BigInt(parameters.blockTimeMs)
  let step = ((latest.timestamp - target) * 1000n + blockTimeMs - 1n) / blockTimeMs

  let high = latest.number
  let low: BlockHeader | undefined
  while (low === undefined) {
    const number = high > step ? high - step : 0n
    const block = await getBlock(number)
    if (block.timestamp === target) return { number, timestamp: block.timestamp }
    if (block.timestamp < target) {
      low = { number, timestamp: block.timestamp }
    } else {
      if (number === 0n) return undefined
      high = number
      step *= 2n
    }
  }

  while (high - low.number > 1n) {
    const number: bigint = (low.number + high) / 2n
    const block = await getBlock(number)
    if (block.timestamp === target) return { number, timestamp: block.timestamp }
    if (block.timestamp < target) low = { number, timestamp: block.timestamp }
    else high = number
  }
  return low
}
