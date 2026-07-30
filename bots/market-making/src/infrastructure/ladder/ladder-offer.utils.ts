import type { IMarket, TreeInput } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { Group, Offer, TickLib, Tree } from '@morpho-org/midnight-sdk'
import { zeroAddress } from 'viem'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { LadderAdapterError } from './ladder-adapter.error'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n

type BuildLadderTreeParameters = {
  quote: LadderQuoteSet
  market: IMarket
  maker: Address
  ratifier: Address
  now: bigint
}

/** Complete locally built ladder tree plus group/rung ownership metadata. */
type PreparedLadderTree = {
  tree: Tree
  groups: readonly LadderGroupReference[]
  bookOffers: readonly { marketId: Hex; buy: boolean; tick: bigint }[]
}

const sideTotal = (rungs: readonly LadderRung[]) =>
  rungs.reduce((total, rung) => total + rung.assets, 0n)

const rateToTick = (rateBps: bigint, market: IMarket, now: bigint) => {
  const timeToMaturity = BigInt(market.params.maturity) - now
  if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
  const periodRateWad = (rateBps * (WAD / 10_000n) * timeToMaturity) / YEAR_SECONDS
  return TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing))
}

const sideOffers = (
  side: 'lower' | 'higher',
  rungs: readonly LadderRung[],
  parameters: BuildLadderTreeParameters
) => {
  const buy = side === 'lower'
  const common = {
    market: parameters.market.params,
    buy,
    maker: parameters.maker,
    expiry: parameters.market.params.maturity,
    ratifier: parameters.ratifier,
    tickSpacing: parameters.market.tickSpacing,
    continuousFeeCap: BigInt(parameters.market.continuousFee),
    ...(buy
      ? {}
      : {
          reduceOnly: true,
          receiverIfMakerIsSeller: zeroAddress
        })
  }
  const cap = parameters.quote.groupMode === 'per-book' ? sideTotal(rungs) : undefined
  return rungs.map(rung => ({
    rung,
    offer: Offer.create({
      ...common,
      tick: rateToTick(rung.rateBps, parameters.market, parameters.now),
      maxAssets: cap ?? rung.assets
    })
  }))
}

/**
 * Converts one domain quote set into the exact mixed-side Midnight offer tree.
 * @param parameters - Quote, fresh market, maker, ratifier, and block timestamp.
 * @returns Tree, protocol-group-to-rung mapping, and prospective book ticks.
 * @throws `LadderAdapterError` when the market has matured; SDK validation errors pass through.
 * @remarks Lower rates map to lend-side buys and higher rates map to reduce-only borrow-side sells.
 * `shared-rung` gives each rung an independent cap; `per-book` shares one cap across each side.
 */
export const buildLadderTree = (parameters: BuildLadderTreeParameters): PreparedLadderTree => {
  const lower = sideOffers('lower', parameters.quote.lower, parameters)
  const higher = sideOffers('higher', parameters.quote.higher, parameters)
  const tagged = [
    ...lower.map(item => ({ ...item, side: 'lower' as const })),
    ...higher.map(item => ({ ...item, side: 'higher' as const }))
  ]
  if (tagged.length === 0) throw new LadderAdapterError('empty-ladder')

  const entries: TreeInput =
    parameters.quote.groupMode === 'per-book'
      ? [
          ...(lower.length > 0 ? [Group.create(lower.map(item => item.offer))] : []),
          ...(higher.length > 0 ? [Group.create(higher.map(item => item.offer))] : [])
        ]
      : tagged.map(item => item.offer)
  const tree = Tree.create(entries)
  const groups =
    parameters.quote.groupMode === 'per-book'
      ? [
          ...(lower.length > 0
            ? [
                {
                  groupId: tree.offers[0]!.group,
                  side: 'lower' as const,
                  rungIndexes: lower.map(item => item.rung.index)
                }
              ]
            : []),
          ...(higher.length > 0
            ? [
                {
                  groupId: tree.offers[lower.length]!.group,
                  side: 'higher' as const,
                  rungIndexes: higher.map(item => item.rung.index)
                }
              ]
            : [])
        ]
      : tree.offers.map((offer, index) => ({
          groupId: offer.group,
          side: tagged[index]!.side,
          rungIndexes: [tagged[index]!.rung.index]
        }))

  return {
    tree,
    groups,
    bookOffers: tree.offers.map(offer => ({
      marketId: parameters.quote.marketId,
      buy: offer.buy,
      tick: offer.tick
    }))
  }
}
