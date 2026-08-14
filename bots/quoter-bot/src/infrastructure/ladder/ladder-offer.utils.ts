import type { IMarket, TreeInput } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { Group, Offer, Tree } from '@morpho-org/midnight-sdk'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'
import type { TickWindow } from '../tick-window.utils'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { offerMaxAssetsByRung } from '../../domain/ladder/ladder'
import {
  alignedRateTick,
  clampTickToWindow,
  isEmptyTickWindow,
  rateTickWindow
} from '../tick-window.utils'
import { LadderAdapterError } from './ladder-adapter.error'

const bigintMin = (left: bigint, right: bigint) => (left < right ? left : right)
const bigintMax = (left: bigint, right: bigint) => (left > right ? left : right)

type BuildLadderTreeParameters = {
  quote: LadderQuoteSet
  market: IMarket
  maker: Address
  ratifier: Address
  now: bigint
  minimumRateBps?: bigint
  maximumRateBps?: bigint
  ownBootstrapBuyTickCeiling?: bigint
}

/** Complete locally built ladder tree plus group/rung ownership metadata. */
type PreparedLadderTree = {
  tree: Tree
  groups: readonly LadderGroupReference[]
  bookOffers: readonly {
    marketId: Hex
    buy: boolean
    tick: bigint
  }[]
}

/** One protocol offer merged from every same-side rung that resolved to the same tick. */
type MergedTickRungs = {
  tick: bigint
  rungs: LadderRung[]
  maxAssets: bigint
}

const sellTickFloor = (parameters: BuildLadderTreeParameters, window: TickWindow) => {
  if (parameters.ownBootstrapBuyTickCeiling === undefined) return undefined
  const cleared = parameters.ownBootstrapBuyTickCeiling + BigInt(parameters.market.tickSpacing)
  return window.highestTick === undefined ? cleared : bigintMin(cleared, window.highestTick)
}

const mergedSideTicks = (
  side: 'lower' | 'higher',
  parameters: BuildLadderTreeParameters,
  derivation: { window: TickWindow; timeToMaturity: bigint }
): MergedTickRungs[] => {
  const { window, timeToMaturity } = derivation
  const rungs = parameters.quote[side]
  const caps = offerMaxAssetsByRung(parameters.quote)[side]
  const floor = side === 'lower' ? sellTickFloor(parameters, window) : undefined
  const merged = new Map<bigint, MergedTickRungs>()
  rungs.forEach((rung, index) => {
    const aligned = alignedRateTick(
      rung.rateBps,
      timeToMaturity,
      BigInt(parameters.market.tickSpacing)
    )
    const bounded = clampTickToWindow(aligned, window)
    const tick = floor === undefined ? bounded : bigintMax(bounded, floor)
    const cap = caps[index]!
    const entry = merged.get(tick)
    if (entry === undefined) {
      merged.set(tick, { tick, rungs: [rung], maxAssets: cap })
      return
    }
    entry.rungs.push(rung)
    if (parameters.quote.groupMode === 'shared-rung') entry.maxAssets += cap
  })
  return [...merged.values()]
}

const sideOffers = (
  side: 'lower' | 'higher',
  entries: readonly MergedTickRungs[],
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
  return entries.map(entry => ({
    entry,
    offer: Offer.create({
      ...common,
      tick: entry.tick,
      maxAssets: entry.maxAssets
    })
  }))
}

/**
 * Converts one domain quote set into the exact mixed-side Midnight offer tree.
 * @param parameters - Quote, fresh market, maker, ratifier, block timestamp, optional minimum and
 * maximum APR bounds in basis points, and an optional highest own bootstrap-buy tick that every
 * sell must clear.
 * @returns Tree, protocol-group-to-rung mapping, and prospective book ticks.
 * @throws `LadderAdapterError` when the market has matured, the ladder is empty, or the hard rate
 * range contains no aligned tick; SDK validation errors pass through.
 * @remarks Midnight prices are inverse to rates, so lower rates map to reduce-only sells and higher
 * rates map to lend buys. A rounded tick outside the supplied hard range saturates at the nearest
 * in-range tick instead of failing, and sells quote strictly above `ownBootstrapBuyTickCeiling`
 * (capped at the minimum-rate tick, where an exact own-offer tie remains possible). Same-side rungs
 * resolving to one tick merge into a single offer whose cap covers every merged rung, so a group
 * may own several rungs even in `shared-rung` mode. Each offer uses the fresh block timestamp as
 * its start so a later publication cannot reuse a previously consumed content-addressed group. This
 * function constructs local values only and does not publish or mutate persisted ownership.
 */
export const buildLadderTree = (parameters: BuildLadderTreeParameters): PreparedLadderTree => {
  const timeToMaturity = BigInt(parameters.market.params.maturity) - parameters.now
  if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
  const window = rateTickWindow({
    ...(parameters.minimumRateBps === undefined
      ? {}
      : { minimumRateBps: parameters.minimumRateBps }),
    ...(parameters.maximumRateBps === undefined
      ? {}
      : { maximumRateBps: parameters.maximumRateBps }),
    timeToMaturity,
    tickSpacing: BigInt(parameters.market.tickSpacing)
  })
  if (isEmptyTickWindow(window)) throw new LadderAdapterError('rate-window-empty')
  const lower = sideOffers(
    'lower',
    mergedSideTicks('lower', parameters, { window, timeToMaturity }),
    parameters
  )
  const higher = sideOffers(
    'higher',
    mergedSideTicks('higher', parameters, { window, timeToMaturity }),
    parameters
  )
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
                  rungIndexes: lower.flatMap(item => item.entry.rungs.map(rung => rung.index))
                }
              ]
            : []),
          ...(higher.length > 0
            ? [
                {
                  groupId: tree.offers[lower.length]!.group,
                  side: 'higher' as const,
                  rungIndexes: higher.flatMap(item => item.entry.rungs.map(rung => rung.index))
                }
              ]
            : [])
        ]
      : tree.offers.map((offer, index) => ({
          groupId: offer.group,
          side: tagged[index]!.side,
          rungIndexes: tagged[index]!.entry.rungs.map(rung => rung.index)
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
