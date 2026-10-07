import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { TakeAmountsLib, TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import type {
  LadderConfig,
  LadderMarketState,
  LadderQuoteSet,
  LadderRung,
  ValidLadderConfig
} from '../../../src/domain/ladder'
import type { OpposingBookTicks } from '../../../src/infrastructure/ladder/ladder-cross-book.utils'

import { generateLadder, offerCapsByRung, validateLadderConfig } from '../../../src/domain/ladder'
import { alignedRateTick, rateTickWindow } from '../../../src/domain/tick-window'
import { calculateLadderCapacities } from '../../../src/infrastructure/ladder/ladder-capacity.utils'
import { retainedOpposingBookTicks } from '../../../src/infrastructure/ladder/ladder-cross-book.utils'
import {
  buildLadderTree,
  minimumOfferUnits,
  buildPublishableLadderTree,
  snapshotRateWindow
} from '../../../src/infrastructure/ladder/ladder-offer.utils'
import { assertLadderProspectiveSpread } from '../../../src/infrastructure/ladder/ladder-spread.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const collateral: Address = '0x5555555555555555555555555555555555555555'
const oracle: Address = '0x6666666666666666666666666666666666666666'
const marketId: Hex = `0x${'77'.repeat(32)}`
const groupId = (byte: string): Hex => `0x${byte.repeat(32)}`
const WAD = MathLib.WAD
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

const inRangeQuote: LadderQuoteSet = {
  ...quote('shared-rung'),
  lower: [
    { index: 0, rateBps: 480n, assets: 10n },
    { index: 1, rateBps: 450n, assets: 20n }
  ]
}

describe('buildLadderTree', () => {
  test('derives exact production offer maxUnits for the [10,20,30,40] fixture in both modes', () => {
    expect(offerCapsByRung(quote('shared-rung'))).toEqual({
      lower: [10n, 20n],
      higher: [30n, 40n]
    })
    expect(offerCapsByRung(quote('per-book'))).toEqual({
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
    expect(result.tree.offers.map(offer => offer.maxUnits)).toEqual([10n, 20n, 30n, 40n])
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
    expect(result.groups.map(group => group.ticks)).toEqual(
      result.tree.offers.map(offer => [offer.tick])
    )
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

    expect(result.tree.offers.map(offer => offer.maxUnits)).toEqual([30n, 30n, 70n, 70n])
    expect(new Set(result.tree.offers.slice(0, 2).map(offer => offer.group)).size).toBe(1)
    expect(new Set(result.tree.offers.slice(2).map(offer => offer.group)).size).toBe(1)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([
      [0, 1],
      [0, 1]
    ])
    expect(result.groups.map(group => group.ticks)).toEqual([
      result.tree.offers.slice(0, 2).map(offer => offer.tick),
      result.tree.offers.slice(2).map(offer => offer.tick)
    ])
  })

  test('refuses a rung outside the hard range instead of saturating it', () => {
    expect(() =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 450n,
        maximumRateBps: 600n
      })
    ).toThrow(expect.objectContaining({ operation: 'rate-out-of-range' }))
  })

  test('encodes rungs on both bounds at ticks whose APR stays inside the range', () => {
    const result = buildLadderTree({
      quote: inRangeQuote,
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n
    })

    expect(result.bookOffers.map(offer => ({ buy: offer.buy, tick: offer.tick }))).toEqual([
      { buy: false, tick: alignedRateTick(480n, BigInt(market.params.maturity) - now, 1n) },
      { buy: false, tick: 3_993n },
      { buy: true, tick: 3_954n },
      { buy: true, tick: 3_937n }
    ])
    expect(result.tree.offers.map(offer => offer.maxUnits)).toEqual([10n, 20n, 30n, 40n])
    const timeToMaturity = BigInt(market.params.maturity) - now
    for (const offer of result.tree.offers) {
      const apr = TickLib.tickToApr(offer.tick, timeToMaturity)
      expect(apr).toBeGreaterThanOrEqual(450n * 10n ** 14n)
      expect(apr).toBeLessThanOrEqual(600n * 10n ** 14n)
    }
  })

  test('keeps every published APR inside the range for generated ladders near maturity', () => {
    const spacings = [1, 2, 4]
    const maturities = [1n, 60n, 3_600n, 86_400n, 7n * 86_400n, 30n * 86_400n]
    const generationConfig = validateLadderConfig({
      marketId,
      quotePremiumBps: 0n,
      spreadBps: 20n,
      stepBps: 15n,
      rungCount: 6,
      sizeSkewBps: 0n,
      lowerRateBudgetAssets: 60n,
      higherRateBudgetAssets: 60n,
      targetMarketExposureAssets: 120n,
      maximumTotalExposureAssets: 120n,
      minimumOfferAssets: 1n,
      groupMode: 'shared-rung',
      loopIntervalSeconds: 60,
      bookCrossedCooldownSeconds: 60,
      movementToleranceBps: 0n,
      minimumRateBps: 300n,
      maximumRateBps: 600n
    })
    const publishedAprs = (
      tickSpacing: number,
      timeToMaturity: bigint,
      referenceRateBps: bigint
    ) => {
      const generated = generateLadder({ config: generationConfig, referenceRateBps })
      if (generated.lower.length + generated.higher.length === 0) return []
      const spacedMarket = {
        ...market,
        params: { ...market.params, maturity: now + timeToMaturity },
        tickSpacing
      } as unknown as IMarket
      try {
        return buildLadderTree({
          quote: generated,
          market: spacedMarket,
          maker,
          ratifier,
          now,
          minimumRateBps: 300n,
          maximumRateBps: 600n
        }).tree.offers.map(offer => TickLib.tickToApr(offer.tick, timeToMaturity))
      } catch (error) {
        expect(error).toMatchObject({ operation: 'rate-window-empty' })
        return 'empty-window' as const
      }
    }
    const references = Array.from({ length: 72 }, (_, index) => 200n + 7n * BigInt(index))
    const outcomes = spacings.flatMap(tickSpacing =>
      maturities.flatMap(timeToMaturity =>
        references.map(reference => publishedAprs(tickSpacing, timeToMaturity, reference))
      )
    )
    const aprs = outcomes.flatMap(outcome => (outcome === 'empty-window' ? [] : outcome))
    for (const apr of aprs) {
      expect(apr).toBeGreaterThanOrEqual(300n * 10n ** 14n)
      expect(apr).toBeLessThanOrEqual(600n * 10n ** 14n)
    }
    const published = aprs.length
    const emptyWindows = outcomes.filter(outcome => outcome === 'empty-window').length
    expect(published).toBeGreaterThan(1_000)
    expect(emptyWindows).toBeGreaterThan(0)
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
    expect(result.tree.offers[0]?.maxUnits).toBe(30n)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0, 1], [0], [1]])
  })

  test('quotes every sell strictly above the own bootstrap buy tick', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n,
      ownBootstrapBuyTickCeiling: 4_018n
    })

    const sells = result.bookOffers.filter(offer => !offer.buy)
    expect(sells).toEqual([{ marketId, buy: false, tick: 4_019n }])
    expect(result.tree.offers[0]?.maxUnits).toBe(30n)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0, 1], [0], [1]])
  })

  test('caps the bootstrap sell clearance at the minimum-rate tick', () => {
    const result = buildLadderTree({
      quote: inRangeQuote,
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

  test('attributes a rung to the book only when the book moved it further', () => {
    const clearedByBook = (ownBootstrapBuyTickCeiling: bigint) =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 1n,
        maximumRateBps: 10_000n,
        ownBootstrapBuyTickCeiling,
        opposingBookTicks: { highestBuyTick: 4_000n }
      }).bookClearedRungs.lower

    // The bootstrap floor already lifts every sell past the book floor, so the book moved nothing.
    expect(clearedByBook(4_018n)).toBe(0)
    expect(clearedByBook(3_900n)).toBe(1)
  })

  test('keeps the own bootstrap tie when the book clearance is looser', () => {
    const result = buildLadderTree({
      quote: inRangeQuote,
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
        quote: inRangeQuote,
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
      quote: inRangeQuote,
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
        maker,
        replacedGroupIds,
        book,
        prospective: prospective()
      })
    ).toThrow('Ladder adapter failed')

    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        maker,
        replacedGroupIds,
        book,
        prospective: prospective(retainedOpposingBookTicks({ marketId, replacedGroupIds, book }))
      })
    ).not.toThrow()
  })

  test('still publishes both sides when the book crosses the whole hard range', () => {
    const result = buildLadderTree({
      quote: inRangeQuote,
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

describe('lend-only ladder publication', () => {
  test.each(['shared-rung', 'per-book'] as const)(
    'publishes only buy groups in %s mode while the maker holds credit',
    groupMode => {
      const lendOnly = validateLadderConfig({
        marketId,
        quotePremiumBps: 0n,
        spreadBps: 200n,
        stepBps: 100n,
        rungCount: 3,
        sizeSkewBps: 0n,
        lowerRateBudgetAssets: 0n,
        higherRateBudgetAssets: 90n,
        targetMarketExposureAssets: 1_000n,
        maximumTotalExposureAssets: 1_000n,
        minimumOfferAssets: 1n,
        groupMode,
        loopIntervalSeconds: 60,
        bookCrossedCooldownSeconds: 60,
        movementToleranceBps: 0n,
        minimumRateBps: 100n,
        maximumRateBps: 1_000n
      })
      const generated = generateLadder({
        config: lendOnly,
        referenceRateBps: 500n,
        capacities: { lowerRateCapacityAssets: 500n, creditAssets: 500n }
      })
      const { prepared, withdrawnSides } = buildPublishableLadderTree({
        quote: generated,
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 100n,
        maximumRateBps: 1_000n
      })

      expect(withdrawnSides).toEqual([])
      expect(prepared!.tree.offers.length).toBeGreaterThan(0)
      expect(prepared!.tree.offers.every(offer => offer.buy)).toBe(true)
      expect(prepared!.groups.every(group => group.side === 'higher')).toBe(true)
      expect(prepared!.groups).toHaveLength(groupMode === 'per-book' ? 1 : 3)
    }
  )
})

describe('ladder offer caps', () => {
  test.each(['shared-rung', 'per-book'] as const)(
    'carry their %s cap as maxUnits with no asset cap',
    groupMode => {
      const { tree } = buildLadderTree({
        quote: quote(groupMode),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 1n,
        maximumRateBps: 10_000n
      })
      const caps = offerCapsByRung(quote(groupMode))

      expect(tree.offers.map(offer => [offer.buy, offer.maxAssets, offer.maxUnits])).toEqual([
        ...caps.lower.map(cap => [false, 0n, cap]),
        ...caps.higher.map(cap => [true, 0n, cap])
      ])
    }
  )
})

describe('face acquired by a fully taken ladder', () => {
  const USDC = 1_000_000n
  const faceLimit = 500_000n * USDC
  const DAY = 86_400n
  const ladderConfig = validateLadderConfig({
    marketId,
    quotePremiumBps: 0n,
    spreadBps: 200n,
    stepBps: 100n,
    rungCount: 3,
    sizeSkewBps: 0n,
    lowerRateBudgetAssets: faceLimit,
    higherRateBudgetAssets: faceLimit,
    targetMarketExposureAssets: faceLimit,
    maximumTotalExposureAssets: faceLimit,
    minimumOfferAssets: 101n * USDC,
    groupMode: 'shared-rung',
    loopIntervalSeconds: 60,
    bookCrossedCooldownSeconds: 180,
    movementToleranceBps: 10n,
    minimumRateBps: 100n,
    maximumRateBps: 2_000n
  })
  const capacitiesWithCash = (balance: bigint) =>
    calculateLadderCapacities({
      marketId,
      balance,
      currentCredit: 0n,
      otherMarketCredit: 0n,
      creditSaleCapacityAssets: 0n,
      targetMarketExposureAssets: faceLimit,
      maximumTotalExposureAssets: faceLimit,
      reservations: []
    })
  const capacities = calculateLadderCapacities({
    marketId,
    balance: 10n * faceLimit,
    currentCredit: 0n,
    otherMarketCredit: 0n,
    creditSaleCapacityAssets: 0n,
    targetMarketExposureAssets: faceLimit,
    maximumTotalExposureAssets: faceLimit,
    reservations: []
  })
  // Midnight `take`: a maker buy pays floor(units × price), and a units-capped group admits units
  // until `consumed` reaches `maxUnits`.
  const fullTake = (offer: { tick: bigint; maxUnits: bigint }) => ({
    face: offer.maxUnits,
    cash: (offer.maxUnits * TickLib.tickToPrice(offer.tick)) / WAD
  })
  const takeLadder = (
    centerRateBps: bigint,
    timeToMaturity: bigint,
    marketCapacities = capacities
  ) => {
    const maturing = { ...market, params: { ...market.params, maturity: now + timeToMaturity } }
    const generated = generateLadder({
      config: ladderConfig,
      referenceRateBps: centerRateBps,
      capacities: {
        ...marketCapacities,
        minimumOfferUnits: minimumOfferUnits({
          minimumOfferAssets: ladderConfig.minimumOfferAssets,
          minimumRateBps: ladderConfig.minimumRateBps,
          maximumRateBps: ladderConfig.maximumRateBps,
          timeToMaturity,
          tickSpacing: 1n
        })
      }
    })
    const { tree } = buildLadderTree({
      quote: generated,
      market: maturing as unknown as IMarket,
      maker,
      ratifier,
      now,
      minimumRateBps: ladderConfig.minimumRateBps,
      maximumRateBps: ladderConfig.maximumRateBps
    })
    const buys = tree.offers.filter(offer => offer.buy).map(fullTake)
    return {
      face: buys.reduce((sum, take) => sum + take.face, 0n),
      cash: buys.reduce((sum, take) => sum + take.cash, 0n),
      smallestCash: buys.reduce(
        (smallest, take) => (take.cash < smallest ? take.cash : smallest),
        faceLimit
      )
    }
  }
  const cases = [300n, 500n, 1_200n].flatMap(rateBps =>
    [DAY, 30n * DAY, 365n * DAY, 5n * 365n * DAY].map(timeToMaturity => ({
      rateBps,
      timeToMaturity
    }))
  )

  test.each(cases)(
    'stays within face and cash limits at $rateBps bps over $timeToMaturity s',
    ({ rateBps, timeToMaturity }) => {
      const taken = takeLadder(rateBps, timeToMaturity)

      expect(taken.face).toBeLessThanOrEqual(faceLimit)
      expect(taken.cash).toBeLessThanOrEqual(capacities.cashBalanceAssets)
      expect(taken.smallestCash).toBeGreaterThanOrEqual(ladderConfig.minimumOfferAssets)
    }
  )

  test.each(cases)(
    'stays within cash when cash binds before face, at $rateBps bps over $timeToMaturity s',
    ({ rateBps, timeToMaturity }) => {
      const cash = 300_000n * USDC
      const taken = takeLadder(rateBps, timeToMaturity, capacitiesWithCash(cash))

      expect(taken.cash).toBeLessThanOrEqual(cash)
      expect(taken.face).toBeLessThanOrEqual(cash)
    }
  )
})

describe('snapshotRateWindow', () => {
  const range = { market, now, minimumRateBps: 300n, maximumRateBps: 600n, minimumOfferAssets: 1n }

  test('sizes rungs in units while the full window holds a tick', () => {
    expect(snapshotRateWindow(range)).toEqual({
      minimumOfferUnits: minimumOfferUnits({
        minimumOfferAssets: 1n,
        minimumRateBps: 300n,
        maximumRateBps: 600n,
        timeToMaturity: BigInt(market.params.maturity) - now,
        tickSpacing: BigInt(market.tickSpacing)
      })
    })
  })

  test('withdraws both sides instead of throwing when the full window holds no tick', () => {
    expect(snapshotRateWindow({ ...range, minimumRateBps: 500n, maximumRateBps: 500n })).toEqual({
      withdrawnSides: ['lower', 'higher']
    })
  })

  test('leaves a matured market to the matured path', () => {
    expect(
      snapshotRateWindow({
        ...range,
        now: BigInt(market.params.maturity),
        minimumRateBps: 500n,
        maximumRateBps: 500n
      })
    ).toEqual({})
  })
})

describe('minimumOfferUnits', () => {
  test('is worth the cash floor at the lowest price the range can publish at', () => {
    const units = minimumOfferUnits({
      minimumOfferAssets: 101_000_000n,
      minimumRateBps: 100n,
      maximumRateBps: 2_000n,
      timeToMaturity: 31_536_000n,
      tickSpacing: 1n
    })
    const lowestTick = rateTickWindow({
      minimumRateBps: 100n,
      maximumRateBps: 2_000n,
      timeToMaturity: 31_536_000n,
      tickSpacing: 1n
    }).lowestTick!

    expect((units * TickLib.tickToPrice(lowestTick)) / WAD).toBeGreaterThanOrEqual(101_000_000n)
    expect(units).toBeGreaterThan(101_000_000n)
  })

  test('fails closed on an empty rate range', () => {
    expect(() =>
      minimumOfferUnits({
        minimumOfferAssets: 1n,
        minimumRateBps: 500n,
        maximumRateBps: 500n,
        timeToMaturity: 31_536_000n,
        tickSpacing: 1n
      })
    ).toThrow(expect.objectContaining({ operation: 'rate-window-empty' }))
  })
})

const settlementFee = 0n
const sellerReceives = (tick: bigint, units: bigint) =>
  (units * TakeAmountsLib.prices({ offer: { buy: true, tick }, settlementFee }).sellerPrice) / WAD
const buyerPays = (tick: bigint, units: bigint) => {
  const price = TakeAmountsLib.prices({ offer: { buy: false, tick }, settlementFee }).buyerPrice
  return (units * price + WAD - 1n) / WAD
}

describe('buildPublishableLadderTree when the full window empties between the snapshot and publication blocks', () => {
  const snapshotNow = 95_782n
  const publicationNow = snapshotNow + 1n
  const narrowRange = { market, maker, ratifier, minimumRateBps: 300n, maximumRateBps: 301n }
  const sells = [{ index: 0, rateBps: 300n, assets: 10n }]
  const buys = [{ index: 0, rateBps: 301n, assets: 10n }]
  const narrowQuote = (lower: LadderRung[], higher: LadderRung[]): LadderQuoteSet => ({
    ...inRangeQuote,
    lower,
    higher
  })

  test('withdraws a sells-only quote', () => {
    const quote = narrowQuote(sells, [])
    expect(
      buildPublishableLadderTree({ ...narrowRange, quote, now: snapshotNow }).withdrawnSides
    ).toEqual([])
    expect(buildPublishableLadderTree({ ...narrowRange, quote, now: publicationNow })).toEqual({
      withdrawnSides: ['lower']
    })
  })

  test('withdraws both sides of a mixed quote', () => {
    const quote = narrowQuote(sells, buys)
    expect(
      buildPublishableLadderTree({ ...narrowRange, quote, now: snapshotNow }).prepared?.groups
    ).toHaveLength(2)
    expect(buildPublishableLadderTree({ ...narrowRange, quote, now: publicationNow })).toEqual({
      withdrawnSides: ['lower', 'higher']
    })
  })

  test('withdraws a buys-only quote', () => {
    const quote = narrowQuote([], buys)
    expect(
      buildPublishableLadderTree({ ...narrowRange, quote, now: snapshotNow }).prepared?.groups
    ).toHaveLength(1)
    expect(buildPublishableLadderTree({ ...narrowRange, quote, now: publicationNow })).toEqual({
      withdrawnSides: ['higher']
    })
  })
})

describe('inventory skew round trip', () => {
  const skewConfig = (groupMode: LadderConfig['groupMode']) =>
    validateLadderConfig({
      marketId,
      quotePremiumBps: 0n,
      spreadBps: 200n,
      stepBps: 100n,
      rungCount: 3,
      sizeSkewBps: 0n,
      lowerRateBudgetAssets: 1_000_000n,
      higherRateBudgetAssets: 1_000_000n,
      targetMarketExposureAssets: 10_000_000n,
      maximumTotalExposureAssets: 10_000_000n,
      minimumOfferAssets: 1n,
      groupMode,
      loopIntervalSeconds: 60,
      bookCrossedCooldownSeconds: 180,
      movementToleranceBps: 10n,
      minimumRateBps: 1n,
      maximumRateBps: 5_000n,
      inventorySkew: { unitsPerStep: 100_000n }
    })
  const offers = (
    ladderConfig: ValidLadderConfig,
    parameters: { centerRateBps?: bigint; capacities: LadderMarketState; bootstrapTick?: bigint }
  ) =>
    buildLadderTree({
      quote: generateLadder({
        config: ladderConfig,
        referenceRateBps: 500n,
        capacities: parameters.capacities,
        ...(parameters.centerRateBps === undefined
          ? {}
          : { retainedCenterRateBps: parameters.centerRateBps })
      }),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: ladderConfig.minimumRateBps,
      maximumRateBps: ladderConfig.maximumRateBps,
      ...(parameters.bootstrapTick === undefined
        ? {}
        : { ownBootstrapBuyTickCeiling: parameters.bootstrapTick })
    }).tree.offers
  const assertNoProfitableBuyBack = (
    filledTick: bigint,
    units: bigint,
    rebuiltSells: readonly { tick: bigint }[]
  ) => {
    expect(rebuiltSells.length).toBeGreaterThan(0)
    for (const sell of rebuiltSells) {
      expect(buyerPays(sell.tick, units)).toBeGreaterThanOrEqual(sellerReceives(filledTick, units))
    }
  }
  const FILLS = [1n, 99_999n, 100_000n, 1_000_000n, 5_000_000n]

  test.each(['shared-rung', 'per-book'] as const)(
    'never lets a %s buy fill be bought back from the rebuilt sells at a profit',
    groupMode => {
      const ladderConfig = skewConfig(groupMode)
      const centers = [500n, 500n + ladderConfig.movementToleranceBps]
      for (const initialCredit of [0n, 250_000n]) {
        const before = offers(ladderConfig, { capacities: { creditAssets: initialCredit } })
        const fills = before
          .filter(offer => offer.buy)
          .flatMap(buy => FILLS.flatMap(units => centers.map(center => ({ buy, units, center }))))
        for (const { buy, units, center } of fills) {
          const after = offers(ladderConfig, {
            centerRateBps: center,
            capacities: { creditAssets: initialCredit + units }
          })
          assertNoProfitableBuyBack(
            buy.tick,
            units,
            after.filter(offer => !offer.buy)
          )
        }
      }
    }
  )

  test('adds no round trip to credit a same-market bootstrap acquired', () => {
    const ladderConfig = skewConfig('shared-rung')
    const { inventorySkew: _inventorySkew, ...unskewedFields } = ladderConfig
    const unskewed = validateLadderConfig(unskewedFields)
    const timeToMaturity = BigInt(market.params.maturity) - now
    const sells = (
      config: ValidLadderConfig,
      units: bigint,
      bootstrap?: { rateBps: bigint; tick: bigint }
    ) =>
      offers(config, {
        capacities: {
          creditAssets: units,
          ...(bootstrap ? { bootstrapBuyRateBps: bootstrap.rateBps } : {})
        },
        ...(bootstrap ? { bootstrapTick: bootstrap.tick } : {})
      })
        .filter(offer => !offer.buy)
        .map(offer => ({ tick: offer.tick, maxAssets: offer.maxAssets }))
    for (const rateBps of [300n, 480n, 500n, 650n]) {
      const bootstrap = { rateBps, tick: alignedRateTick(rateBps, timeToMaturity, 1n) }
      for (const units of FILLS) {
        expect(sells(ladderConfig, units, bootstrap)).toEqual(sells(unskewed, units, bootstrap))
        expect(sells(ladderConfig, units)).toEqual(sells(unskewed, units))
        assertNoProfitableBuyBack(bootstrap.tick, units, sells(ladderConfig, units, bootstrap))
      }
    }
  })
})
