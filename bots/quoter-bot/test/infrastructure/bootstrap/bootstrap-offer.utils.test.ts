import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import { createBoundedBootstrapOffer } from '../../../src/infrastructure/bootstrap/bootstrap-offer.utils'

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
  tickSpacing: 4,
  continuousFee: 0
} as unknown as IMarket

const offer = {
  marketId,
  assets: 100n,
  rateBps: 521n,
  referenceObservationId: 'test'
}

describe('createBoundedBootstrapOffer', () => {
  test('moves a coarse buy tick below the crossing sell while preserving exact hard bounds', () => {
    const crossingSellTick = TickLib.priceToTick(TickLib.rateToPrice(512n * 10n ** 14n), 4n)

    const result = createBoundedBootstrapOffer({
      offer,
      market,
      maker,
      ratifier,
      now,
      minimumRateBps: 200n,
      maximumRateBps: 800n,
      maximumExclusiveTick: crossingSellTick
    })

    expect(result.created.tick).toBeLessThan(crossingSellTick)
    expect(result.effectiveAprWad).toBeGreaterThanOrEqual(200n * 10n ** 14n)
    expect(result.effectiveAprWad).toBeLessThanOrEqual(800n * 10n ** 14n)
    expect(result.effectiveRateBps).toBe(523n)
  })

  test('rejects a strict gap when the next buy tick exceeds the maximum effective APR', () => {
    const crossingSellTick = TickLib.priceToTick(TickLib.rateToPrice(512n * 10n ** 14n), 4n)

    expect(() =>
      createBoundedBootstrapOffer({
        offer,
        market,
        maker,
        ratifier,
        now,
        minimumRateBps: 200n,
        maximumRateBps: 520n,
        maximumExclusiveTick: crossingSellTick
      })
    ).toThrow('Position bootstrap adapter failed')
  })
})
