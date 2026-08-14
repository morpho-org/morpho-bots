import type { IMarket, TreeInput } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { Group, MAX_TICK, Offer, TickLib, Tree } from '@morpho-org/midnight-sdk'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { offerMaxAssetsByRung } from '../../domain/ladder/ladder'
import { findRepresentableRateTick } from '../rate-tick-reconstruction.utils'
import { LadderAdapterError } from './ladder-adapter.error'

const WAD = 10n ** 18n
const BPS_WAD = WAD / 10_000n
const YEAR_SECONDS = 31_536_000n
const CROSS_BOOK_RATE_GAP_BPS = 10n

type BuildLadderTreeParameters = {
  quote: LadderQuoteSet
  market: IMarket
  maker: Address
  ratifier: Address
  now: bigint
  minimumRateBps?: bigint
  maximumRateBps?: bigint
  bootstrapBuyTick?: bigint
  bootstrapBuyRateBps?: bigint
}

/** Complete locally built ladder tree plus group/rung ownership metadata. */
type PreparedLadderTree = {
  quote: LadderQuoteSet
  tree: Tree
  groups: readonly LadderGroupReference[]
  bookOffers: readonly {
    marketId: Hex
    buy: boolean
    tick: bigint
    remainingAssets: bigint
    effectiveRateBps: bigint
  }[]
}

const rateToTick = (rateBps: bigint, market: IMarket, now: bigint) => {
  const timeToMaturity = BigInt(market.params.maturity) - now
  if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
  const periodRateWad = (rateBps * (WAD / 10_000n) * timeToMaturity) / YEAR_SECONDS
  return TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing))
}

const quoteTick = (rateBps: bigint, parameters: BuildLadderTreeParameters) =>
  rateToTick(rateBps, parameters.market, parameters.now)

const effectiveAprWad = (tick: bigint, parameters: BuildLadderTreeParameters) =>
  TickLib.tickToApr(tick, BigInt(parameters.market.params.maturity) - parameters.now)

const firstAlignedTickAtOrBelowApr = (
  maximumAprWad: bigint,
  tickSpacing: bigint,
  parameters: BuildLadderTreeParameters
) => {
  let low = 0n
  let high = MAX_TICK / tickSpacing
  while (low < high) {
    const middle = (low + high) / 2n
    if (effectiveAprWad(middle * tickSpacing, parameters) <= maximumAprWad) high = middle
    else low = middle + 1n
  }
  return low * tickSpacing
}

const lastAlignedTickAtOrAboveApr = (
  minimumAprWad: bigint,
  tickSpacing: bigint,
  parameters: BuildLadderTreeParameters
) => {
  let low = 0n
  let high = MAX_TICK / tickSpacing
  while (low < high) {
    const middle = (low + high + 1n) / 2n
    if (effectiveAprWad(middle * tickSpacing, parameters) >= minimumAprWad) low = middle
    else high = middle - 1n
  }
  return low * tickSpacing
}

const boundedQuoteTick = (
  side: 'lower' | 'higher',
  rateBps: bigint,
  parameters: BuildLadderTreeParameters,
  minimumExclusiveTick?: bigint
) => {
  const tickSpacing = BigInt(parameters.market.tickSpacing)
  const lowestTick =
    parameters.maximumRateBps === undefined
      ? 0n
      : firstAlignedTickAtOrBelowApr(parameters.maximumRateBps * BPS_WAD, tickSpacing, parameters)
  const highestTick =
    parameters.minimumRateBps === undefined
      ? MAX_TICK
      : lastAlignedTickAtOrAboveApr(parameters.minimumRateBps * BPS_WAD, tickSpacing, parameters)
  const firstTickAfterCrossing =
    minimumExclusiveTick === undefined
      ? lowestTick
      : (minimumExclusiveTick / tickSpacing + 1n) * tickSpacing
  const minimumTick = firstTickAfterCrossing > lowestTick ? firstTickAfterCrossing : lowestTick
  const rateIsOutOfBounds =
    (parameters.minimumRateBps !== undefined && rateBps < parameters.minimumRateBps) ||
    (parameters.maximumRateBps !== undefined && rateBps > parameters.maximumRateBps)
  const requestedTick = rateIsOutOfBounds
    ? side === 'lower'
      ? highestTick
      : lowestTick
    : quoteTick(rateBps, parameters)
  const tick = requestedTick < minimumTick ? minimumTick : requestedTick
  const boundedTick = tick > highestTick ? highestTick : tick
  const aprWad = effectiveAprWad(boundedTick, parameters)
  if (
    minimumTick > highestTick ||
    (parameters.minimumRateBps !== undefined && aprWad < parameters.minimumRateBps * BPS_WAD) ||
    (parameters.maximumRateBps !== undefined && aprWad > parameters.maximumRateBps * BPS_WAD)
  ) {
    throw new LadderAdapterError('encoded-rate-out-of-bounds')
  }
  const representable = findRepresentableRateTick({
    targetTick: boundedTick,
    minimumTick,
    maximumTick: highestTick,
    minimumRateBps: parameters.minimumRateBps ?? rateBps,
    maximumRateBps: parameters.maximumRateBps ?? rateBps,
    minimumAprWad:
      parameters.minimumRateBps === undefined ? undefined : parameters.minimumRateBps * BPS_WAD,
    maximumAprWad:
      parameters.maximumRateBps === undefined ? undefined : parameters.maximumRateBps * BPS_WAD,
    rateToTick: candidateRateBps => quoteTick(candidateRateBps, parameters),
    tickToAprWad: candidateTick => effectiveAprWad(candidateTick, parameters)
  })
  if (representable === undefined) {
    throw new LadderAdapterError('integer-rate-not-representable')
  }
  return { tick: representable.tick, effectiveRateBps: representable.rateBps }
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
  const merged = new Map<bigint, { rungs: LadderRung[]; maxAssets: bigint }>()
  for (const [index, rung] of rungs.entries()) {
    const requestedTick = quoteTick(rung.rateBps, parameters)
    const crossingBootstrap =
      side === 'lower' &&
      parameters.bootstrapBuyTick !== undefined &&
      parameters.bootstrapBuyRateBps !== undefined &&
      requestedTick <= parameters.bootstrapBuyTick
    const crossingRateBps =
      crossingBootstrap && parameters.bootstrapBuyRateBps !== undefined
        ? parameters.bootstrapBuyRateBps - CROSS_BOOK_RATE_GAP_BPS
        : rung.rateBps
    const nominalRateIsOutOfBounds =
      (parameters.minimumRateBps !== undefined && rung.rateBps < parameters.minimumRateBps) ||
      (parameters.maximumRateBps !== undefined && rung.rateBps > parameters.maximumRateBps)
    const sideBoundaryRateBps =
      side === 'lower' ? parameters.minimumRateBps : parameters.maximumRateBps
    const rateBps = nominalRateIsOutOfBounds
      ? (sideBoundaryRateBps ?? rung.rateBps)
      : crossingBootstrap &&
          ((parameters.minimumRateBps !== undefined &&
            crossingRateBps < parameters.minimumRateBps) ||
            (parameters.maximumRateBps !== undefined &&
              crossingRateBps > parameters.maximumRateBps))
        ? (parameters.minimumRateBps ?? crossingRateBps)
        : crossingRateBps
    const bounded = boundedQuoteTick(
      side,
      rateBps,
      parameters,
      crossingBootstrap ? parameters.bootstrapBuyTick : undefined
    )
    const adjusted = nominalRateIsOutOfBounds || crossingBootstrap || bounded.tick !== requestedTick
    const adjustedRung = adjusted ? { ...rung, rateBps: bounded.effectiveRateBps } : rung
    const tick = bounded.tick
    const existing = merged.get(tick)
    if (existing) {
      existing.rungs.push(adjustedRung)
      if (parameters.quote.groupMode === 'shared-rung') {
        existing.maxAssets += maxAssetsByRung[index]!
      }
    } else {
      merged.set(tick, { rungs: [adjustedRung], maxAssets: maxAssetsByRung[index]! })
    }
  }
  return [...merged].map(([tick, item]) => ({
    rungs: item.rungs,
    offer: Offer.create({ ...common, tick, maxAssets: item.maxAssets })
  }))
}

/**
 * Converts one domain quote set into the exact mixed-side Midnight offer tree.
 * @param parameters - Quote, fresh market, maker, ratifier, block timestamp, optional integer APR
 * bounds, and optional exact owned-bootstrap buy tick/rate evidence.
 * @returns Adjusted quote, tree, protocol-group-to-rung mapping, and prospective book ticks.
 * @throws `LadderAdapterError` when the market has matured or the ladder is empty; SDK validation
 * errors pass through.
 * @remarks Midnight prices are inverse to rates, so lower rates map to reduce-only sells and higher
 * rates map to lend buys. This keeps every buy tick strictly below every sell tick. Each offer uses
 * the fresh block timestamp as its start so a later publication cannot reuse a previously consumed
 * content-addressed group. `shared-rung` gives each rung an independent cap; `per-book` shares one
 * cap across each side. Crossing sells move at least ten nominal basis points below an owned bootstrap
 * buy, then advance to the next safe sell tick when spacing would erase the strict spread. Supplied
 * hard bounds are enforced against exact tick-derived APR, duplicate ticks merge, and every adjusted
 * rung is returned with a reconstruction-safe effective integer-bps quote for persistence. This
 * function constructs local values only and does not publish or mutate persisted ownership.
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
                  rungIndexes: lower.flatMap(item => item.rungs.map(rung => rung.index))
                }
              ]
            : []),
          ...(higher.length > 0
            ? [
                {
                  groupId: tree.offers[lower.length]!.group,
                  side: 'higher' as const,
                  rungIndexes: higher.flatMap(item => item.rungs.map(rung => rung.index))
                }
              ]
            : [])
        ]
      : tree.offers.map((offer, index) => ({
          groupId: offer.group,
          side: tagged[index]!.side,
          rungIndexes: tagged[index]!.rungs.map(rung => rung.index)
        }))

  return {
    quote: {
      ...parameters.quote,
      lower: lower.flatMap(item => item.rungs),
      higher: higher.flatMap(item => item.rungs)
    },
    tree,
    groups,
    bookOffers: tree.offers.map((offer, index) => ({
      marketId: parameters.quote.marketId,
      buy: offer.buy,
      tick: offer.tick,
      remainingAssets: offer.maxAssets,
      effectiveRateBps: tagged[index]!.rungs[0]!.rateBps
    }))
  }
}
