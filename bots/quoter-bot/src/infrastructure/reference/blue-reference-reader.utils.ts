import type { Hex } from 'viem'

import { fetchMarket } from '@morpho-org/morpho-sdk/fetch'
import { MathLib } from '@morpho-org/morpho-ts'

import type { SupportedChainId } from '../../config/supported-chains.utils'
import type {
  BlueReferenceReader,
  BlueSupplyCheckpoint
} from '../bootstrap/bootstrap-reference-rate.service'
import type { BlockHeader } from '../provider/historical-block.utils'

import { supportedChain } from '../../config/supported-chains.utils'
import { findBlockAtOrBefore } from '../provider/historical-block.utils'
import { ReferenceAdapterError } from './reference-adapter.error'

const WAD = MathLib.WAD

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
 * @param referenceMarketId - Exact configured Blue Market ID.
 * @param client - Historical block and Morpho Market reader.
 * @param chainId - Configured chain, whose nominal block time seeds the historical block search.
 * @returns Latest and at-or-before checkpoint operations.
 * @throws `ReferenceAdapterError` for a null latest block, for a target older than the chain, or
 * for a checkpoint whose block predates the reference market; provider errors pass through.
 * @remarks This utility performs no request until a returned operation is called. Historical
 * blocks are located by timestamp with {@link findBlockAtOrBefore}, the same routine readiness uses.
 */
export const createBlueReferenceReader = (
  referenceMarketId: Hex,
  client: HistoricalBlockReader,
  chainId: SupportedChainId
): BlueReferenceReader => {
  const blockTimeMs = supportedChain(chainId).blockTime
  const latestHeader = async (): Promise<BlockHeader> => {
    const block = await client.getBlock({ blockTag: 'latest' })
    if (block.number === null) throw new ReferenceAdapterError('latest-block')
    return { number: block.number, timestamp: block.timestamp }
  }
  const checkpoint = async (block: BlockHeader): Promise<BlueSupplyCheckpoint> => {
    const market = await fetchMarket(
      referenceMarketId as Parameters<typeof fetchMarket>[0],
      client as never,
      { blockNumber: block.number, deployless: false }
    )
    // A block predating the market resolves to zeroed state rather than an error, and Blue's
    // virtual shares then price one WAD of shares identically to a real market that has not yet
    // accrued. Left unchecked this annualizes the market's whole lifetime over the configured
    // window and understates the reference. Same predicate the readiness probe applies.
    if (market.lastUpdate === 0n || market.totalSupplyShares === 0n) {
      throw new ReferenceAdapterError('reference-uninitialized')
    }
    const accrued = market.accrueInterest(block.timestamp)
    return {
      blockNumber: block.number,
      timestamp: block.timestamp,
      supplyAssetsPerWadShares: accrued.toSupplyAssets(WAD)
    }
  }
  return {
    readLatest: async () => checkpoint(await latestHeader()),
    readAtOrBefore: async (target, head) => {
      const block = await findBlockAtOrBefore({
        latest: { number: head.blockNumber, timestamp: head.timestamp },
        target,
        getBlock: blockNumber => client.getBlock({ blockNumber }),
        blockTimeMs
      })
      if (block === undefined) throw new ReferenceAdapterError('reference-history')
      return checkpoint(block)
    }
  }
}
