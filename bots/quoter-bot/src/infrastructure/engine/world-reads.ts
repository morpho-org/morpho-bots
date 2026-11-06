import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import { midnightAbi } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { blockTagAt } from '@repo/kit'
import { createPublicClient, erc20Abi, getAbiItem, http, isAddressEqual } from 'viem'

import type { WorldPosition } from '../../application/engine/world'
import type { ConfigService } from '../../config/config.service'
import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'

import { supportedChain } from '../../config/supported-chains.utils'
import { LadderAdapterError } from '../../errors'
import { readLadderBookOffers } from '../ladder/ladder-book.utils'
import { readMakerOfferGroups } from '../provider/offer-groups.utils'

/** One block, as every chain read of a poll is pinned to it by its hash. */
export type WorldBlock = Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>

/**
 * The raw reads world polls and preparations make; production reads the chain and the API, tests
 * replace it.
 */
export type WorldReads = Readonly<{
  /** The latest block's number, hash and timestamp, read together. */
  readLatestBlock: () => Promise<WorldBlock>
  /** A market's state at `block`. */
  readMarket: (marketId: Hex, block: WorldBlock) => Promise<IMarket>
  /** The maker's offer groups as the API indexes them now; not pinned to a block. */
  readGroups: () => Promise<readonly MakerOfferGroup[]>
  /** A market's takeable book from the API now; not pinned to a block. */
  readBook: (marketId: Hex) => Promise<readonly OwnedOverlapBookOffer[]>
  /** The maker's position in a market, accrued to `block`. */
  readPosition: (marketId: Hex, block: WorldBlock) => Promise<WorldPosition>
  /** The maker's loan-token balance and Midnight allowance at `block`. */
  readCash: (block: WorldBlock) => Promise<{ cashBalance: bigint; allowance: bigint }>
  /** Each group's consumption at `block`, in `groupIds` order. */
  readConsumed: (groupIds: readonly Hex[], block: WorldBlock) => Promise<readonly bigint[]>
}>

const consumedAbi = [getAbiItem({ abi: midnightAbi, name: 'consumed' })]

/**
 * The production world reads: the maker's offer groups and each ladder book from the Morpho API,
 * and every chain value pinned to the block it is asked at by hash (EIP-1898), so a read the node
 * cannot serve at that block fails rather than reading another fork's block of the same height.
 * @param config - Validated runtime config: chain, RPC, timeouts, and the maker.
 * @returns The production reads; no request is made until called.
 */
export const createWorldReads = (config: ConfigService): WorldReads => {
  const maker = config.identity.maker
  const client = createPublicClient({
    chain: supportedChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  }).extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = client.morpho.midnight(config.chainId)
  return {
    readLatestBlock: async () => {
      const { number, hash, timestamp } = await client.getBlock({ blockTag: 'latest' })
      return { number, hash, timestamp }
    },
    readMarket: (marketId, block) =>
      midnight.getMarketData(marketId, { blockTag: blockTagAt(block.hash) }),
    readGroups: () =>
      readMakerOfferGroups({
        adapterError: LadderAdapterError,
        chainId: config.chainId,
        maker,
        morphoApiBaseUrl: config.morphoApiBaseUrl,
        requestTimeoutMs: config.requestTimeoutMs
      }),
    readBook: marketId =>
      readLadderBookOffers({
        baseUrl: config.morphoApiBaseUrl,
        marketIds: [marketId],
        timeoutMs: config.requestTimeoutMs
      }),
    readPosition: async (marketId, block) => {
      const data = await midnight.getPositionData({
        marketId,
        accountAddress: maker,
        parameters: { blockTag: blockTagAt(block.hash) }
      })
      const position = data.accrueInterest(block.timestamp)
      const loanIndex = data.market.params.collateralParams.findIndex(slot =>
        isAddressEqual(slot.token, data.market.params.loanToken)
      )
      const loanSlot = data.market.params.collateralParams[loanIndex]
      const assets = loanSlot === undefined ? undefined : position.collateral[loanIndex]
      if (loanSlot !== undefined && assets === undefined)
        throw new LadderAdapterError('position-unavailable')
      return {
        marketId,
        ...(loanSlot === undefined
          ? {}
          : { loanCollateral: { assets: assets!, lltv: loanSlot.lltv } }),
        credit: position.credit,
        debt: position.debt,
        lossFactor: data.market.lossFactor,
        maturity: data.market.params.maturity,
        tickSpacing: data.market.tickSpacing,
        continuousFee: data.market.continuousFee
      }
    },
    readCash: async block => {
      const [cashBalance, allowance] = await Promise.all([
        client.readContract({
          address: config.setup.loanAsset,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [maker],
          blockTag: blockTagAt(block.hash)
        }),
        client.readContract({
          address: config.setup.loanAsset,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [maker, config.setup.midnight],
          blockTag: blockTagAt(block.hash)
        })
      ])
      return { cashBalance, allowance }
    },
    readConsumed: (groupIds, block) =>
      client.multicall({
        contracts: groupIds.map(
          groupId =>
            ({
              address: config.setup.midnight,
              abi: consumedAbi,
              functionName: 'consumed',
              args: [maker, groupId]
            }) as const
        ),
        allowFailure: false,
        blockTag: blockTagAt(block.hash)
      })
  }
}
