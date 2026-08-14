import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { MAX_TICK, TickLib } from '@morpho-org/midnight-sdk'
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
const yearSeconds = 31_536_000n
const basisPointWad = 10n ** 14n
const rateToTick = (rateBps: bigint, candidateMarket: IMarket, timestamp: bigint) => {
  const timeToMaturity = BigInt(candidateMarket.params.maturity) - timestamp
  const periodRateWad = (rateBps * basisPointWad * timeToMaturity) / yearSeconds
  return TickLib.priceToTick(
    TickLib.rateToPrice(periodRateWad),
    BigInt(candidateMarket.tickSpacing)
  )
}
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
  test('selects a reconstructable neighbor for unrepresentable crossing tick 4173', () => {
    const fineMarket = { ...market, tickSpacing: 1 } as IMarket
    const result = createBoundedBootstrapOffer({
      offer: { ...offer, rateBps: 184n },
      market: fineMarket,
      maker,
      ratifier,
      now,
      minimumRateBps: 100n,
      maximumRateBps: 300n,
      maximumExclusiveTick: 4_174n
    })
    const reconstructedTick = TickLib.priceToTick(
      TickLib.rateToPrice((result.effectiveRateBps * basisPointWad * yearSeconds) / yearSeconds),
      1n
    )

    expect(TickLib.tickToApr(4_173n, yearSeconds)).toBe(18_407_719_530_514_042n)
    expect(result.created.tick).not.toBe(4_173n)
    expect(result.created.tick).toBeLessThan(4_174n)
    expect(reconstructedTick).toBe(result.created.tick)
  })

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

  test('round-trips adjusted buys across sampled maturities, spacings, and both out-of-range directions', () => {
    for (const timeToMaturity of [7n * 86_400n, 90n * 86_400n, yearSeconds]) {
      for (const tickSpacing of [1, 2, 4]) {
        const sampledMarket = {
          ...market,
          params: { ...market.params, maturity: now + timeToMaturity },
          tickSpacing
        } as IMarket
        const boundaryTicks: bigint[] = []
        for (const nominalRateBps of [99n, 301n]) {
          const result = createBoundedBootstrapOffer({
            offer: { ...offer, rateBps: nominalRateBps },
            market: sampledMarket,
            maker,
            ratifier,
            now,
            minimumRateBps: 100n,
            maximumRateBps: 300n,
            maximumExclusiveTick: MAX_TICK
          })
          const aprWad = TickLib.tickToApr(result.created.tick, timeToMaturity)
          boundaryTicks.push(result.created.tick)

          expect(rateToTick(result.effectiveRateBps, sampledMarket, now)).toBe(result.created.tick)
          expect(aprWad).toBeGreaterThanOrEqual(100n * basisPointWad)
          expect(aprWad).toBeLessThanOrEqual(300n * basisPointWad)
        }
        expect(boundaryTicks[0]).toBe(boundaryTicks[1])
      }
    }
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
