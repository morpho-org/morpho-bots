import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'
import type { OpposingBookTicks } from '../../../src/infrastructure/ladder/ladder-cross-book.utils'

import { offerMaxAssetsByRung } from '../../../src/domain/ladder/ladder'
import { retainedOpposingBookTicks } from '../../../src/infrastructure/ladder/ladder-cross-book.utils'
import { buildLadderTree } from '../../../src/infrastructure/ladder/ladder-offer.utils'
import { assertLadderProspectiveSpread } from '../../../src/infrastructure/ladder/ladder-spread.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const collateral: Address = '0x5555555555555555555555555555555555555555'
const oracle: Address = '0x6666666666666666666666666666666666666666'
const marketId: Hex = `0x${'77'.repeat(32)}`
const groupId = (byte: string): Hex => `0x${byte.repeat(32)}`
const now = 1_000n
const market = {
  params: {
    chainId: 8453,
    midnight,
    loanToken,
    collateralParams: [
      {
        token: collateral,
        lltv: 800_000_000_000_000_000n,
        liquidationCursor: 0n,
        oracle
      }
    ],
    maturity: now + 31_536_000n,
    rcfThreshold: 0n,
    enterGate: '0x0000000000000000000000000000000000000000',
    liquidatorGate: '0x0000000000000000000000000000000000000000'
  },
  tickSpacing: 1,
  continuousFee: 0
} as unknown as IMarket

const quote = (groupMode: LadderQuoteSet['groupMode']): LadderQuoteSet => ({
  marketId,
  centerRateBps: 500n,
  groupMode,
  lower: [
    { index: 0, rateBps: 450n, assets: 10n },
    { index: 1, rateBps: 400n, assets: 20n }
  ],
  higher: [
    { index: 0, rateBps: 550n, assets: 30n },
    { index: 1, rateBps: 600n, assets: 40n }
  ]
})

describe('buildLadderTree', () => {
  test('derives exact production offer maxAssets for the [10,20,30,40] fixture in both modes', () => {
    expect(offerMaxAssetsByRung(quote('shared-rung'))).toEqual({
      lower: [10n, 20n],
      higher: [30n, 40n]
    })
    expect(offerMaxAssetsByRung(quote('per-book'))).toEqual({
      lower: [30n, 30n],
      higher: [70n, 70n]
    })
  })

  test('maps lower sells and higher buys without crossing Midnight ticks', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })

    expect(result.tree.offers.map(offer => offer.buy)).toEqual([false, false, true, true])
    expect(result.tree.offers.map(offer => offer.maxAssets)).toEqual([10n, 20n, 30n, 40n])
    expect(result.tree.offers.slice(0, 2).every(offer => offer.reduceOnly)).toBe(true)
    expect(result.tree.offers.slice(0, 2).map(offer => offer.receiverIfMakerIsSeller)).toEqual([
      maker,
      maker
    ])
    const buyTicks = result.bookOffers.filter(offer => offer.buy).map(offer => offer.tick)
    const sellTicks = result.bookOffers.filter(offer => !offer.buy).map(offer => offer.tick)
    expect(buyTicks.every(buyTick => sellTicks.every(sellTick => buyTick < sellTick))).toBe(true)
    expect(result.tree.offers.every(offer => offer.start === now)).toBe(true)
    expect(new Set(result.tree.offers.map(offer => offer.group)).size).toBe(4)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0], [1], [0], [1]])
  })

  test('derives fresh group IDs for a later publication of the same quote', () => {
    const first = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })
    const later = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now: now + 1n,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })

    const firstGroups = new Set(first.groups.map(group => group.groupId))
    expect(later.groups.every(group => !firstGroups.has(group.groupId))).toBe(true)
  })

  test('shares one exact cap across every rung in each per-book side', () => {
    const result = buildLadderTree({
      quote: quote('per-book'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })

    expect(result.tree.offers.map(offer => offer.maxAssets)).toEqual([30n, 30n, 70n, 70n])
    expect(new Set(result.tree.offers.slice(0, 2).map(offer => offer.group)).size).toBe(1)
    expect(new Set(result.tree.offers.slice(2).map(offer => offer.group)).size).toBe(1)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([
      [0, 1],
      [0, 1]
    ])
  })

  test('reconstructs persisted pending offers without applying current strategy bounds', () => {
    expect(() =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now
      })
    ).not.toThrow()
  })

  test('saturates out-of-range ticks at the hard range and merges rungs meeting there', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n
    })

    expect(result.bookOffers.map(offer => ({ buy: offer.buy, tick: offer.tick }))).toEqual([
      { buy: false, tick: 3_993n },
      { buy: true, tick: 3_954n },
      { buy: true, tick: 3_937n }
    ])
    expect(result.tree.offers.map(offer => offer.maxAssets)).toEqual([30n, 30n, 40n])
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0, 1], [0], [1]])
    const timeToMaturity = BigInt(market.params.maturity) - now
    const basisPointWad = 10n ** 14n
    for (const offer of result.tree.offers) {
      const encodedRateBps = TickLib.tickToApr(offer.tick, timeToMaturity) / basisPointWad
      expect(encodedRateBps).toBeGreaterThanOrEqual(450n)
      expect(encodedRateBps).toBeLessThanOrEqual(600n)
    }
  })

  test('merges same-side rungs whose rates round onto one protocol tick', () => {
    const result = buildLadderTree({
      quote: {
        ...quote('shared-rung'),
        lower: [
          { index: 0, rateBps: 453n, assets: 10n },
          { index: 1, rateBps: 452n, assets: 20n }
        ]
      },
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })

    const sells = result.bookOffers.filter(offer => !offer.buy)
    expect(sells).toEqual([{ marketId, buy: false, tick: 3_993n }])
    expect(result.tree.offers[0]?.maxAssets).toBe(30n)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0, 1], [0], [1]])
  })

  test('quotes every sell strictly above the own bootstrap buy tick', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      ownBootstrapBuyTickCeiling: 4_018n
    })

    const sells = result.bookOffers.filter(offer => !offer.buy)
    expect(sells).toEqual([{ marketId, buy: false, tick: 4_019n }])
    expect(result.tree.offers[0]?.maxAssets).toBe(30n)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0, 1], [0], [1]])
  })

  test('caps the bootstrap sell clearance at the minimum-rate tick', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n,
      ownBootstrapBuyTickCeiling: 3_993n
    })

    const sells = result.bookOffers.filter(offer => !offer.buy)
    expect(sells).toEqual([{ marketId, buy: false, tick: 3_993n }])
  })

  test('reprices sells just clear of the best resting bid', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n,
      opposingBookTicks: { highestBuyTick: 4_000n }
    })

    expect(result.bookOffers.filter(offer => !offer.buy).map(offer => offer.tick)).toEqual([
      4_001n,
      4_018n
    ])
  })

  test('reprices buys just clear of the best resting ask', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n,
      opposingBookTicks: { lowestSellTick: 3_945n }
    })

    expect(result.bookOffers.filter(offer => offer.buy).map(offer => offer.tick)).toEqual([
      3_944n,
      3_937n
    ])
  })

  test('counts only the rungs the opposing book repriced', () => {
    const counts = (parameters: Partial<Parameters<typeof buildLadderTree>[0]>) =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 1n,
        maximumRateBps: 10_000n,
        ...parameters
      }).bookClearedRungs

    expect(counts({})).toEqual({ lower: 0, higher: 0 })
    expect(counts({ opposingBookTicks: { highestBuyTick: 4_000n } })).toEqual({
      lower: 1,
      higher: 0
    })
    expect(counts({ opposingBookTicks: { lowestSellTick: 3_945n } })).toEqual({
      lower: 0,
      higher: 1
    })
    expect(counts({ ownBootstrapBuyTickCeiling: 4_018n })).toEqual({ lower: 0, higher: 0 })
  })

  test('counts a book-constrained rung even when the bootstrap floor is the binding one', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n,
      ownBootstrapBuyTickCeiling: 4_018n,
      opposingBookTicks: { highestBuyTick: 4_000n }
    })

    expect(result.bookClearedRungs.lower).toBe(1)
    expect(result.bookOffers.filter(offer => !offer.buy).map(offer => offer.tick)).toEqual([4_019n])
  })

  test('keeps the own bootstrap tie when the book clearance is looser', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n,
      ownBootstrapBuyTickCeiling: 3_993n,
      opposingBookTicks: { highestBuyTick: 3_950n }
    })

    expect(result.bookOffers.filter(offer => !offer.buy)).toEqual([
      { marketId, buy: false, tick: 3_993n }
    ])
  })

  test('saturates the book clearance at the hard range rather than quoting outside it', () => {
    const sells = (opposingBookTicks: OpposingBookTicks) =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 450n,
        maximumRateBps: 600n,
        opposingBookTicks
      }).bookOffers.filter(offer => !offer.buy)

    expect(sells({ highestBuyTick: 3_993n })).toEqual([{ marketId, buy: false, tick: 3_993n }])
    expect(sells({ highestBuyTick: 9_999n })).toEqual([{ marketId, buy: false, tick: 3_993n }])
  })

  test('saturates a buy clearance below the hard range at the maximum-rate tick', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n,
      opposingBookTicks: { lowestSellTick: 3_937n }
    })

    expect(result.bookOffers.filter(offer => offer.buy)).toEqual([
      { marketId, buy: true, tick: 3_937n }
    ])
  })

  test('keeps every clearance aligned to a market tick spacing wider than one', () => {
    const spaced = { ...market, tickSpacing: 4 } as unknown as IMarket
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market: spaced,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n,
      opposingBookTicks: { highestBuyTick: 3_996n, lowestSellTick: 3_952n }
    })

    expect(result.bookOffers.map(offer => offer.tick)).toEqual([4_000n, 4_020n, 3_948n, 3_940n])
    expect(result.bookOffers.every(offer => offer.tick % 4n === 0n)).toBe(true)
  })

  test('clears the crossed-book guard a resting bid inside the ladder would trip', () => {
    const restingBid = { groupId: groupId('09'), marketId, buy: true, tick: 4_000n }
    const book = [restingBid]
    const replacedGroupIds = new Set<Hex>()
    const prospective = (opposingBookTicks?: OpposingBookTicks) =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 1n,
        maximumRateBps: 10_000n,
        ...(opposingBookTicks === undefined ? {} : { opposingBookTicks })
      }).bookOffers.map(offer => ({
        ...offer,
        ...(offer.buy ? {} : { overlapOwner: 'ladder-sell' as const })
      }))

    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds,
        book,
        prospective: prospective()
      })
    ).toThrow('Ladder adapter failed')

    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds,
        book,
        prospective: prospective(retainedOpposingBookTicks({ marketId, replacedGroupIds, book }))
      })
    ).not.toThrow()
  })

  test('still publishes both sides when the book crosses the whole hard range', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n,
      opposingBookTicks: { highestBuyTick: 9_999n, lowestSellTick: 1n }
    })

    expect(result.bookOffers.some(offer => offer.buy)).toBe(true)
    expect(result.bookOffers.some(offer => !offer.buy)).toBe(true)
    const timeToMaturity = BigInt(market.params.maturity) - now
    const basisPointWad = 10n ** 14n
    for (const offer of result.tree.offers) {
      const encodedRateBps = TickLib.tickToApr(offer.tick, timeToMaturity) / basisPointWad
      expect(encodedRateBps).toBeGreaterThanOrEqual(450n)
      expect(encodedRateBps).toBeLessThanOrEqual(600n)
    }
  })

  test('rejects a hard range too narrow to contain any aligned tick', () => {
    expect(() =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 500n,
        maximumRateBps: 500n
      })
    ).toThrow('Ladder adapter failed')
  })
})
