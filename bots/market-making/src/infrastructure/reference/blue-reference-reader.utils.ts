import { fetchMarket } from '@morpho-org/morpho-sdk/fetch'

import type {
  BlueReferenceReader,
  BlueSupplyCheckpoint
} from '../bootstrap/bootstrap-reference-rate.service'

import { ReferenceAdapterError } from './reference-adapter.error'

const WAD = 10n ** 18n

/** Minimal historical block boundary needed by the Blue reference reader. */
export type HistoricalBlockReader = {
  /**
   * Reads the latest or one exact historical block.
   * @param parameters - Latest tag or exact block number selector.
   * @returns Block number availability and timestamp.
   * @throws When the configured provider cannot return the selected block.
   */
  getBlock(parameters: { blockTag: 'latest' } | { blockNumber: bigint }): Promise<{
    number: bigint | null
    timestamp: bigint
  }>
}

/**
 * Creates the shared archive-backed Morpho Blue supply checkpoint reader.
 * @param referenceMarketId - Exact configured Blue market ID.
 * @param client - Historical block and Morpho market reader.
 * @returns Latest and at-or-before checkpoint operations.
 * @throws `ReferenceAdapterError` for a null latest block; provider errors pass through.
 * @remarks This utility performs no request until a returned operation is called.
 */
export const createBlueReferenceReader = (
  referenceMarketId: `0x${string}`,
  client: HistoricalBlockReader
): BlueReferenceReader => {
  const checkpoint = async (blockNumber: bigint): Promise<BlueSupplyCheckpoint> => {
    const block = await client.getBlock({ blockNumber })
    const market = await fetchMarket(
      referenceMarketId as Parameters<typeof fetchMarket>[0],
      client as never,
      { blockNumber, deployless: false }
    )
    const accrued = market.accrueInterest(block.timestamp)
    return {
      blockNumber,
      timestamp: block.timestamp,
      supplyAssetsPerWadShares: accrued.toSupplyAssets(WAD)
    }
  }
  return {
    readLatest: async () => {
      const block = await client.getBlock({ blockTag: 'latest' })
      if (block.number === null) throw new ReferenceAdapterError('latest-block')
      return checkpoint(block.number)
    },
    readAtOrBefore: async target => {
      const latest = await client.getBlock({ blockTag: 'latest' })
      if (latest.number === null) throw new ReferenceAdapterError('latest-block')
      let low = 0n
      let high = latest.number
      while (low < high) {
        const middle = (low + high + 1n) / 2n
        const block = await client.getBlock({ blockNumber: middle })
        if (block.timestamp <= target) low = middle
        else high = middle - 1n
      }
      return checkpoint(low)
    }
  }
}
