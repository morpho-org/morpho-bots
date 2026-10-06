import type { IMarket, TreeInput } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { Group, Offer, Tree } from '@morpho-org/midnight-sdk'

import type { LadderMarketState, LadderQuoteSet, LadderRung } from '../../domain/ladder'
import type { TickWindow } from '../../domain/tick-window'
import type { OpposingBookTicks } from './ladder-cross-book.utils'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { offerCapsByRung } from '../../domain/ladder'
import { unitsForBuyerAssetsAtTick } from '../../domain/offer-cap'
import {
  admissibleRateTick,
  alignTickDown,
  alignTickUp,
  isEmptyTickWindow,
  LOWEST_TICK,
  rateTickWindow
} from '../../domain/tick-window'
import { LadderAdapterError } from './ladder-adapter.error'

const bigintMin = (left: bigint, right: bigint) => (left < right ? left : right)
const bigintMax = (left: bigint, right: bigint) => (left > right ? left : right)

type BuildLadderTreeParameters = {
  quote: LadderQuoteSet
  market: IMarket
  maker: Address
  ratifier: Address
  now: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  maximumSellRateBps?: bigint
  ownBootstrapBuyTickCeiling?: bigint
  opposingBookTicks?: OpposingBookTicks
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
  /** Rungs per side the opposing book repriced, before equal-tick rungs merged. */
  bookClearedRungs: { lower: number; higher: number }
}

/** One protocol offer merged from every same-side rung that resolved to the same tick. */
type MergedTickRungs = {
  tick: bigint
  rungs: LadderRung[]
  cap: bigint
}

const sellTickFloor = (
  opposingBuyTick: bigint | undefined,
  parameters: BuildLadderTreeParameters,
  window: TickWindow
) => {
  if (opposingBuyTick === undefined) return undefined
  const cleared = alignTickUp(opposingBuyTick + 1n, BigInt(parameters.market.tickSpacing))
  return window.highestTick === undefined ? cleared : bigintMin(cleared, window.highestTick)
}

const buyTickCeiling = (parameters: BuildLadderTreeParameters, window: TickWindow) => {
  const lowestSellTick = parameters.opposingBookTicks?.lowestSellTick
  if (lowestSellTick === undefined) return undefined
  const cleared =
    lowestSellTick <= LOWEST_TICK
      ? LOWEST_TICK
      : alignTickDown(lowestSellTick - 1n, BigInt(parameters.market.tickSpacing))
  return window.lowestTick === undefined ? cleared : bigintMax(cleared, window.lowestTick)
}

/**
 * Resolves the tick bound for one side, alongside the bound the same side would have without the
 * opposing book.
 * @remarks The pair exists so the guardrail count reports rungs the book actually moved. A rung the
 * own bootstrap buy would have moved just as far is not attributed to the book, which keeps
 * `guardrail.book-cleared` and `guardrail.cross-book-cleared` from both claiming it.
 */
const sideTickBounds = (
  side: 'lower' | 'higher',
  parameters: BuildLadderTreeParameters,
  window: TickWindow
) => {
  if (side === 'higher')
    return { bound: buyTickCeiling(parameters, window), withoutBook: undefined }
  const book = sellTickFloor(parameters.opposingBookTicks?.highestBuyTick, parameters, window)
  const bootstrap = sellTickFloor(parameters.ownBootstrapBuyTickCeiling, parameters, window)
  const bound =
    book === undefined || bootstrap === undefined ? (book ?? bootstrap) : bigintMax(book, bootstrap)
  return { bound, withoutBook: bootstrap }
}

type SideTickDerivation = {
  window: TickWindow
  range: Parameters<typeof admissibleRateTick>[1]
}

const mergedSideTicks = (
  side: 'lower' | 'higher',
  parameters: BuildLadderTreeParameters,
  derivation: SideTickDerivation
) => {
  const { window, range } = derivation
  const rungs = parameters.quote[side]
  const caps = offerCapsByRung(parameters.quote)[side]
  const { bound, withoutBook } = sideTickBounds(side, parameters, window)
  const saturate = side === 'lower' ? bigintMax : bigintMin
  let clearedByBook = 0
  const merged = new Map<bigint, MergedTickRungs>()
  rungs.forEach((rung, index) => {
    const bounded = admissibleRateTick(rung.rateBps, range, window)
    if (bounded === undefined) throw new LadderAdapterError('rate-out-of-range')
    const tick = bound === undefined ? bounded : saturate(bounded, bound)
    const withoutBookTick = withoutBook === undefined ? bounded : saturate(bounded, withoutBook)
    if (tick !== withoutBookTick) clearedByBook += 1
    const cap = caps[index]!
    const entry = merged.get(tick)
    if (entry === undefined) {
      merged.set(tick, { tick, rungs: [rung], cap })
      return
    }
    entry.rungs.push(rung)
    if (parameters.quote.groupMode === 'shared-rung') entry.cap += cap
  })
  return { entries: [...merged.values()], clearedByBook }
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
      maxUnits: entry.cap
    })
  }))
}

/**
 * Converts the cash rung floor into the credit-unit floor rungs are sized by.
 * @param parameters - Cash floor, hard rate range, seconds to maturity, and tick spacing.
 * @returns The fewest units worth `minimumOfferAssets` at the range's lowest price, so a rung of
 * that size clears the floor at every tick it can be published at, measured in units or in assets.
 * @throws `LadderAdapterError` `rate-window-empty` when the range holds no tick or its lowest price
 * is zero.
 */
export const minimumOfferUnits = (parameters: {
  minimumOfferAssets: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  timeToMaturity: bigint
  tickSpacing: bigint
}) => {
  const window = rateTickWindow(parameters)
  const units =
    window.lowestTick === undefined || isEmptyTickWindow(window)
      ? undefined
      : unitsForBuyerAssetsAtTick(parameters.minimumOfferAssets, window.lowestTick)
  if (units === undefined) throw new LadderAdapterError('rate-window-empty')
  return units
}

type LadderTreeBounds = Pick<
  BuildLadderTreeParameters,
  'market' | 'now' | 'minimumRateBps' | 'maximumRateBps' | 'maximumSellRateBps'
>

const ladderTickRanges = (parameters: LadderTreeBounds) => {
  const timeToMaturity = BigInt(parameters.market.params.maturity) - parameters.now
  const range = {
    minimumRateBps: parameters.minimumRateBps,
    maximumRateBps: parameters.maximumRateBps,
    timeToMaturity,
    tickSpacing: BigInt(parameters.market.tickSpacing)
  }
  const sellRange =
    parameters.maximumSellRateBps === undefined
      ? range
      : {
          ...range,
          maximumRateBps: bigintMin(range.maximumRateBps, parameters.maximumSellRateBps)
        }
  return { timeToMaturity, range, sellRange }
}

const LADDER_SIDES = ['lower', 'higher'] as const

const emptySideWindows = (parameters: LadderTreeBounds) => {
  const { timeToMaturity, range, sellRange } = ladderTickRanges(parameters)
  if (timeToMaturity <= 0n) return { lower: false, higher: false }
  const higher = isEmptyTickWindow(rateTickWindow(range))
  return { lower: higher || isEmptyTickWindow(rateTickWindow(sellRange)), higher }
}

/**
 * Reads the snapshot-block rate-window state the ladder decision sizes and withdraws by.
 * @param parameters - Market, snapshot timestamp, hard rate range, optional sell ceiling, and the
 * cash rung floor.
 * @returns The sides whose window holds no tick (an empty full window withdraws both), and
 * {@link minimumOfferUnits} whenever the full window holds one; nothing once the market has matured,
 * leaving that to the matured path.
 * @remarks Tick rounding depends on time to maturity, so a window that holds a tick at the snapshot
 * can be empty at the next block; {@link buildPublishableLadderTree} re-applies this at publication.
 */
export const snapshotRateWindow = (
  parameters: LadderTreeBounds & {
    minimumRateBps: bigint
    maximumRateBps: bigint
    minimumOfferAssets: bigint
  }
): Pick<LadderMarketState, 'withdrawnSides' | 'minimumOfferUnits'> => {
  const { timeToMaturity, range } = ladderTickRanges(parameters)
  if (timeToMaturity <= 0n) return {}
  const empty = emptySideWindows(parameters)
  const withdrawnSides = LADDER_SIDES.filter(side => empty[side])
  return {
    ...(withdrawnSides.length === 0 ? {} : { withdrawnSides }),
    ...(empty.higher
      ? {}
      : {
          minimumOfferUnits: minimumOfferUnits({
            minimumOfferAssets: parameters.minimumOfferAssets,
            minimumRateBps: parameters.minimumRateBps,
            maximumRateBps: parameters.maximumRateBps,
            timeToMaturity,
            tickSpacing: range.tickSpacing
          })
        })
  }
}

/**
 * Builds the publication tree with every side withdrawn whose tick window is empty at the tree's
 * own block, so the other side still replaces instead of {@link buildLadderTree} refusing the
 * whole ladder.
 * @param parameters - As for {@link buildLadderTree}.
 * @returns The sides of `quote` withdrawn, and the tree of what remains; no tree when every side
 * was withdrawn, so the caller cancels rather than keep the replaced offers live.
 * @throws As for {@link buildLadderTree}.
 * @remarks Only for publishing a fresh quote. Reconstructing an already published quote must keep
 * calling {@link buildLadderTree}, which fails closed rather than hide live offers.
 */
export const buildPublishableLadderTree = (
  parameters: BuildLadderTreeParameters
): { prepared?: PreparedLadderTree; withdrawnSides: readonly ('lower' | 'higher')[] } => {
  const empty = emptySideWindows(parameters)
  const withdrawnSides = LADDER_SIDES.filter(
    side => empty[side] && parameters.quote[side].length > 0
  )
  if (withdrawnSides.length === 0) return { prepared: buildLadderTree(parameters), withdrawnSides }
  const quote = {
    ...parameters.quote,
    lower: withdrawnSides.includes('lower') ? [] : parameters.quote.lower,
    higher: withdrawnSides.includes('higher') ? [] : parameters.quote.higher
  }
  if (quote.lower.length === 0 && quote.higher.length === 0) return { withdrawnSides }
  return { prepared: buildLadderTree({ ...parameters, quote }), withdrawnSides }
}

/**
 * Converts one domain quote set into the exact mixed-side Midnight offer tree.
 * @param parameters - Quote, fresh market, maker, ratifier, block timestamp, optional minimum and
 * maximum APR bounds in basis points, an optional lower maximum for sells alone, an optional highest
 * own bootstrap-buy tick that every sell must clear, and the optional opposing retained book ticks
 * both sides must clear.
 * @returns Tree, protocol-group-to-rung mapping, and prospective book ticks.
 * @throws `LadderAdapterError` when the market has matured, the ladder is empty, the hard rate
 * range (or, with sells, the sell range under `maximumSellRateBps`) contains no aligned tick, or a
 * rung's rate is outside it (`rate-out-of-range`, which
 * generation already omits); SDK validation errors pass through.
 * @remarks Midnight prices are inverse to rates, so lower rates map to reduce-only sells and higher
 * rates map to lend buys. Each rung is encoded by {@link admissibleRateTick}, so tick rounding never
 * carries a published APR past a bound, and sells quote strictly above `ownBootstrapBuyTickCeiling`
 * (capped at the minimum-rate tick, where an exact own-offer tie remains possible). Rungs crossing
 * `opposingBookTicks` reprice to the nearest tick just clear of it, saturating at the same hard
 * bound: a book that crosses the whole configured range is left to the publication spread guard
 * rather than silently repriced outside the operator's rates. Same-side rungs
 * resolving to one tick merge into a single offer whose cap covers every merged rung, so a group
 * may own several rungs even in `shared-rung` mode. Each offer uses the fresh block timestamp as
 * its start so a later publication cannot reuse a previously consumed content-addressed group. This
 * function constructs local values only and does not publish or mutate persisted ownership.
 */
export const buildLadderTree = (parameters: BuildLadderTreeParameters): PreparedLadderTree => {
  const { timeToMaturity, range, sellRange } = ladderTickRanges(parameters)
  if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
  const window = rateTickWindow(range)
  if (isEmptyTickWindow(window)) throw new LadderAdapterError('rate-window-empty')
  const sellWindow = sellRange === range ? window : rateTickWindow(sellRange)
  if (parameters.quote.lower.length > 0 && isEmptyTickWindow(sellWindow)) {
    throw new LadderAdapterError('rate-window-empty')
  }
  const lowerTicks = mergedSideTicks('lower', parameters, { window: sellWindow, range: sellRange })
  const higherTicks = mergedSideTicks('higher', parameters, { window, range })
  const lower = sideOffers('lower', lowerTicks.entries, parameters)
  const higher = sideOffers('higher', higherTicks.entries, parameters)
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
  const groupTicks = (groupId: Hex) =>
    tree.offers.filter(offer => offer.group === groupId).map(offer => offer.tick)
  const groupRungs =
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
  const groups = groupRungs.map(group => ({ ...group, ticks: groupTicks(group.groupId) }))

  return {
    tree,
    groups,
    bookClearedRungs: { lower: lowerTicks.clearedByBook, higher: higherTicks.clearedByBook },
    bookOffers: tree.offers.map(offer => ({
      marketId: parameters.quote.marketId,
      buy: offer.buy,
      tick: offer.tick
    }))
  }
}
