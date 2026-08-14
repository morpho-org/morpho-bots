import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { offerMaxAssetsByRung } from '../../../src/domain/ladder/ladder'
import { buildLadderTree } from '../../../src/infrastructure/ladder/ladder-offer.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const collateral: Address = '0x5555555555555555555555555555555555555555'
const oracle: Address = '0x6666666666666666666666666666666666666666'
const marketId: Hex = `0x${'77'.repeat(32)}`
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

  test('moves a crossing ladder sell to the next safe coarse tick when nominal adjustment rounds to equality', () => {
    const coarseMarket = { ...market, tickSpacing: 4 } as IMarket
    const bootstrap = buildLadderTree({
      quote: {
        ...quote('shared-rung'),
        lower: [],
        higher: [{ index: 0, rateBps: 522n, assets: 1n }]
      },
      market: coarseMarket,
      maker,
      ratifier,
      now
    })
    const bootstrapBuyTick = bootstrap.bookOffers[0]!.tick

    const result = buildLadderTree({
      quote: {
        ...quote('shared-rung'),
        lower: [{ index: 0, rateBps: 530n, assets: 10n }],
        higher: []
      },
      market: coarseMarket,
      maker,
      ratifier,
      now,
      minimumRateBps: 200n,
      maximumRateBps: 800n,
      bootstrapBuyTick,
      bootstrapBuyRateBps: 522n
    })

    const adjusted = result.bookOffers[0]!
    const effectiveAprWad = TickLib.tickToApr(adjusted.tick, 31_536_000n)
    const effectiveRateBps = (effectiveAprWad + 10n ** 14n - 1n) / 10n ** 14n
    expect(adjusted.tick).toBeGreaterThan(bootstrapBuyTick)
    expect(effectiveAprWad).toBeGreaterThanOrEqual(200n * 10n ** 14n)
    expect(effectiveAprWad).toBeLessThanOrEqual(800n * 10n ** 14n)
    expect(adjusted.effectiveRateBps).toBe(effectiveRateBps)
    expect(result.quote.lower[0]?.rateBps).toBe(effectiveRateBps)

    const reconstructed = buildLadderTree({
      quote: result.quote,
      market: coarseMarket,
      maker,
      ratifier,
      now,
      minimumRateBps: 200n,
      maximumRateBps: 800n
    })
    expect(reconstructed.bookOffers[0]?.tick).toBe(adjusted.tick)
  })

  test('moves spacing-aligned ticks inside inclusive exact APR bounds', () => {
    const result = buildLadderTree({
      quote: {
        ...quote('shared-rung'),
        lower: [{ index: 0, rateBps: 450n, assets: 10n }],
        higher: [{ index: 0, rateBps: 600n, assets: 10n }]
      },
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 450n,
      maximumRateBps: 600n
    })

    const effectiveAprWads = result.bookOffers.map(offer =>
      TickLib.tickToApr(offer.tick, 31_536_000n)
    )
    expect(effectiveAprWads.every(apr => apr >= 450n * 10n ** 14n)).toBe(true)
    expect(effectiveAprWads.every(apr => apr <= 600n * 10n ** 14n)).toBe(true)
    expect(result.quote.lower[0]?.rateBps).toBe(452n)
    expect(result.bookOffers[0]?.effectiveRateBps).toBe(452n)
  })

  test('rejects a crossing sell when no bounded tick remains above the bootstrap buy', () => {
    const coarseMarket = { ...market, tickSpacing: 4 } as IMarket
    const bootstrapBuyTick = TickLib.priceToTick(TickLib.rateToPrice(522n * 10n ** 14n), 4n)

    expect(() =>
      buildLadderTree({
        quote: {
          ...quote('shared-rung'),
          lower: [{ index: 0, rateBps: 530n, assets: 10n }],
          higher: []
        },
        market: coarseMarket,
        maker,
        ratifier,
        now,
        minimumRateBps: 502n,
        maximumRateBps: 800n,
        bootstrapBuyTick,
        bootstrapBuyRateBps: 522n
      })
    ).toThrow('Ladder adapter failed')
  })

  test('merges ladder rungs that encode to the same tick', () => {
    const sameTickQuote: LadderQuoteSet = {
      ...quote('shared-rung'),
      lower: [
        { index: 0, rateBps: 450n, assets: 10n },
        { index: 1, rateBps: 450n, assets: 20n }
      ],
      higher: []
    }

    const result = buildLadderTree({
      quote: sameTickQuote,
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })

    expect(result.tree.offers).toHaveLength(1)
    expect(result.tree.offers[0]?.maxAssets).toBe(30n)
    expect(result.groups).toMatchObject([{ side: 'lower', rungIndexes: [0, 1] }])
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

  test('accepts an encoded APR fraction above the integer-bps maximum', () => {
    const permissive = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })
    const encodedRateWad = TickLib.tickToApr(
      permissive.tree.offers.at(-1)!.tick,
      BigInt(market.params.maturity) - now
    )
    const basisPointWad = 10n ** 14n
    expect(encodedRateWad % basisPointWad).not.toBe(0n)

    expect(() =>
      buildLadderTree({
        quote: quote('shared-rung'),
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 1n,
        maximumRateBps: encodedRateWad / basisPointWad
      })
    ).not.toThrow()
  })

  test('does not throw when tick rounding moves the encoded APR past a hard boundary', () => {
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
    ).not.toThrow()
  })
})
