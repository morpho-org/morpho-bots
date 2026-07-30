import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

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
  test('maps lower sells and higher buys without crossing Midnight ticks', () => {
    const result = buildLadderTree({
      quote: quote('shared-rung'),
      market,
      maker,
      ratifier,
      now
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
    expect(new Set(result.tree.offers.map(offer => offer.group)).size).toBe(4)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([[0], [1], [0], [1]])
  })

  test('shares one exact cap across every rung in each per-book side', () => {
    const result = buildLadderTree({
      quote: quote('per-book'),
      market,
      maker,
      ratifier,
      now
    })

    expect(result.tree.offers.map(offer => offer.maxAssets)).toEqual([30n, 30n, 70n, 70n])
    expect(new Set(result.tree.offers.slice(0, 2).map(offer => offer.group)).size).toBe(1)
    expect(new Set(result.tree.offers.slice(2).map(offer => offer.group)).size).toBe(1)
    expect(result.groups.map(group => group.rungIndexes)).toEqual([
      [0, 1],
      [0, 1]
    ])
  })
})
