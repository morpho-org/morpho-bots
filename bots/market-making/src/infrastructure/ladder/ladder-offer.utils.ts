import type { IMarket, TreeInput } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { Group, Offer, OfferUtils, TickLib, Tree } from '@morpho-org/midnight-sdk'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { offerMaxAssetsByRung } from '../../domain/ladder/ladder'
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
  quote: LadderQuoteSet
  tree: Tree
  groups: readonly LadderGroupReference[]
  bookOffers: readonly { marketId: Hex; buy: boolean; tick: bigint }[]
}

const rateToTick = (rateBps: bigint, market: IMarket, now: bigint) => {
  const timeToMaturity = BigInt(market.params.maturity) - now
  if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
  const periodRateWad = (rateBps * (WAD / 10_000n) * timeToMaturity) / YEAR_SECONDS
  return TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing))
}

const sideOffers = (
  side: 'lower' | 'higher',
  rungs: readonly LadderRung[],
  maxAssetsByRung: readonly bigint[],
  parameters: BuildLadderTreeParameters
) => {
  const buy = side === 'higher'
  const common = {
    market: parameters.market.params,
    buy,
    maker: parameters.maker,
    start: parameters.now,
    expiry: parameters.market.params.maturity,
    ratifier: parameters.ratifier,
    tickSpacing: parameters.market.tickSpacing,
    continuousFeeCap: BigInt(parameters.market.continuousFee),
    ...(buy
      ? {}
      : {
          reduceOnly: true,
          receiverIfMakerIsSeller: parameters.maker
        })
  }
  return rungs.map((rung, index) => ({
    rung,
    offer: Offer.create({
      ...common,
      tick: rateToTick(rung.rateBps, parameters.market, parameters.now),
      maxAssets: maxAssetsByRung[index]!
    })
  }))
}

/**
 * Converts one domain quote set into the exact mixed-side Midnight offer tree.
 * @param parameters - Quote, fresh market, maker, ratifier, and block timestamp.
 * @returns Tree, protocol-group-to-rung mapping, and prospective book ticks.
 * @throws `LadderAdapterError` when the market has matured; SDK validation errors pass through.
 * @remarks Midnight prices are inverse to rates, so lower rates map to reduce-only sells and higher
 * rates map to lend buys. This keeps every buy tick strictly below every sell tick. Each offer uses
 * the fresh block timestamp as its start so a later publication cannot reuse a previously consumed
 * content-addressed group. `shared-rung` gives each rung an independent cap; `per-book` shares one
 * cap across each side.
 */
export const buildLadderTree = (parameters: BuildLadderTreeParameters): PreparedLadderTree => {
  const caps = offerMaxAssetsByRung(parameters.quote)
  const lower = sideOffers('lower', parameters.quote.lower, caps.lower, parameters)
  const higher = sideOffers('higher', parameters.quote.higher, caps.higher, parameters)
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
                  rungIndexes: lower.map(item => item.rung.index),
                  ticks: lower.map(item => item.offer.tick),
                  continuousFeeCap: BigInt(parameters.market.continuousFee)
                }
              ]
            : []),
          ...(higher.length > 0
            ? [
                {
                  groupId: tree.offers[lower.length]!.group,
                  side: 'higher' as const,
                  rungIndexes: higher.map(item => item.rung.index),
                  ticks: higher.map(item => item.offer.tick),
                  continuousFeeCap: BigInt(parameters.market.continuousFee)
                }
              ]
            : [])
        ]
      : tree.offers.map((offer, index) => ({
          groupId: offer.group,
          side: tagged[index]!.side,
          rungIndexes: [tagged[index]!.rung.index],
          ticks: [offer.tick],
          continuousFeeCap: BigInt(parameters.market.continuousFee)
        }))

  return {
    quote: parameters.quote,
    tree,
    groups,
    bookOffers: tree.offers.map(offer => ({
      marketId: parameters.quote.marketId,
      buy: offer.buy,
      tick: offer.tick
    }))
  }
}

/**
 * Returns canonical group-deduplicated credit reserved by prepared buy-side offers.
 * @param prepared - Exact prepared tree, group mapping, and quote.
 * @param market - Hydrated market used for fee and maturity semantics.
 * @param timestamp - Timestamp at which offer eligibility and settlement fees are evaluated.
 * @returns Sum of each independent group's maximum eligible credit outcome.
 */
export const preparedLadderBuyCredit = (
  prepared: PreparedLadderTree,
  market: IMarket,
  timestamp: bigint
) =>
  prepared.groups
    .filter(group => group.side === 'higher')
    .reduce((total, group) => {
      const credits = prepared.tree.offers
        .filter(offer => offer.group === group.groupId && offer.buy)
        .map(offer =>
          OfferUtils.getConsumableUnits({
            offer: {
              market,
              buy: offer.buy,
              start: offer.start,
              expiry: offer.expiry,
              tick: offer.tick,
              maxUnits: offer.maxUnits,
              maxAssets: offer.maxAssets,
              continuousFeeCap: offer.continuousFeeCap
            },
            consumed: 0n,
            timestamp
          })
        )
      return total + credits.reduce((largest, credit) => (credit > largest ? credit : largest), 0n)
    }, 0n)

/**
 * Caps a prospective ladder's raw buy allocations at an exact canonical credit boundary.
 * @param parameters - Quote, hydrated market, publication identity, timestamp, and credit ceiling.
 * @returns Prepared tree whose group-deduplicated canonical buy credit does not exceed the ceiling.
 * @remarks Raw cash allocations remain proportional; shared protocol groups reserve only their
 * maximum eligible offer outcome while independent rung groups add their individual outcomes.
 */
export const capLadderBuyCredit = (
  parameters: BuildLadderTreeParameters & { maximumCredit: bigint }
): PreparedLadderTree => {
  const totalAssets = parameters.quote.higher.reduce((sum, rung) => sum + rung.assets, 0n)
  const quoteAt = (assets: bigint): LadderQuoteSet => {
    if (totalAssets === 0n || assets === totalAssets) return parameters.quote
    const higher = parameters.quote.higher.map(rung => ({
      ...rung,
      assets: (rung.assets * assets) / totalAssets
    }))
    const allocated = higher.reduce((sum, rung) => sum + rung.assets, 0n)
    const first = higher.find(rung => rung.assets > 0n) ?? higher[0]
    if (first) first.assets += assets - allocated
    return { ...parameters.quote, higher: higher.filter(rung => rung.assets > 0n) }
  }
  let lower = 0n
  let upper = totalAssets
  while (lower < upper) {
    const candidate = lower + (upper - lower + 1n) / 2n
    const prepared = buildLadderTree({ ...parameters, quote: quoteAt(candidate) })
    if (
      preparedLadderBuyCredit(prepared, parameters.market, parameters.now) <=
      parameters.maximumCredit
    ) {
      lower = candidate
    } else {
      upper = candidate - 1n
    }
  }
  return buildLadderTree({ ...parameters, quote: quoteAt(lower) })
}
