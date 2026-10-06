import { describe, expect, test } from 'vitest'

import { findBlockAtOrBefore } from '../../../src/infrastructure/provider/historical-block.utils'

const GENESIS_TIMESTAMP = 1_700_000_000n

/** A chain whose blocks arrive every `secondsPerBlock`, counting probes as they happen. */
const chain = (height: bigint, secondsPerBlock: bigint) => {
  const probes: bigint[] = []
  const timestampOf = (blockNumber: bigint) => GENESIS_TIMESTAMP + blockNumber * secondsPerBlock
  return {
    probes,
    latest: { number: height, timestamp: timestampOf(height) },
    getBlock: async (blockNumber: bigint) => {
      probes.push(blockNumber)
      return { timestamp: timestampOf(blockNumber) }
    },
    timestampOf
  }
}

describe('findBlockAtOrBefore', () => {
  test('returns the latest block without probing when it is already at or before the target', async () => {
    const subject = chain(1_000n, 2n)

    expect(
      await findBlockAtOrBefore({
        ...subject,
        target: subject.latest.timestamp,
        blockTimeMs: 2_000
      })
    ).toEqual(subject.latest)
    expect(subject.probes).toEqual([])
  })

  test('lands on an exact timestamp in one probe when blocks keep the nominal cadence', async () => {
    const subject = chain(1_000_000n, 2n)

    const found = await findBlockAtOrBefore({
      ...subject,
      target: subject.timestampOf(1_000_000n) - 259_200n,
      blockTimeMs: 2_000
    })

    expect(found).toEqual({ number: 870_400n, timestamp: subject.timestampOf(870_400n) })
    expect(subject.probes).toEqual([870_400n])
  })

  test('binary-searches inside the bracket when blocks are slower than nominal', async () => {
    // Missed mainnet slots stretch twelve-second blocks to sixteen, so the nominal seed reaches
    // past the target and only the window itself needs searching.
    const subject = chain(100_000n, 16n)
    const target = subject.timestampOf(100_000n) - 3_600n

    const found = await findBlockAtOrBefore({ ...subject, target, blockTimeMs: 12_000 })

    expect(found).toEqual({ number: 99_775n, timestamp: target })
    expect(subject.probes[0]).toBe(100_000n - 300n)
    expect(subject.probes.length).toBeLessThanOrEqual(1 + 9)
  })

  test('gallops backwards when blocks are faster than the nominal seed', async () => {
    const subject = chain(10_000n, 1n)
    const target = subject.timestampOf(10_000n) - 100n

    const found = await findBlockAtOrBefore({ ...subject, target, blockTimeMs: 2_000 })

    expect(found).toEqual({ number: 9_900n, timestamp: target })
    expect(subject.probes.slice(0, 2)).toEqual([9_950n, 9_850n])
  })

  test('selects the newest block strictly before a target between two blocks', async () => {
    const subject = chain(1_000n, 2n)

    const found = await findBlockAtOrBefore({
      ...subject,
      target: subject.timestampOf(500n) + 1n,
      blockTimeMs: 2_000
    })

    expect(found).toEqual({ number: 500n, timestamp: subject.timestampOf(500n) })
  })

  test('returns undefined when even the genesis block is newer than the target', async () => {
    const subject = chain(100n, 2n)

    const found = await findBlockAtOrBefore({
      ...subject,
      target: GENESIS_TIMESTAMP - 1n,
      blockTimeMs: 2_000
    })

    expect(found).toBeUndefined()
    expect(subject.probes.at(-1)).toBe(0n)
  })

  test('returns the genesis block when it alone satisfies the target', async () => {
    const subject = chain(100n, 2n)

    const found = await findBlockAtOrBefore({
      ...subject,
      target: GENESIS_TIMESTAMP + 1n,
      blockTimeMs: 2_000
    })

    expect(found).toEqual({ number: 0n, timestamp: GENESIS_TIMESTAMP })
  })
})
