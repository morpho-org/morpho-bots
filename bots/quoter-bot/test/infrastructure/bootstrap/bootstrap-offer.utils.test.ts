import type { Address, Hex } from 'viem'

import { InvalidOfferParameterError, TickLib, type IMarketParams } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import {
  decidePositionBootstrap,
  validateBootstrapConfig
} from '../../../src/domain/position-bootstrap'
import {
  bootstrapRateWindowIsEmpty,
  createBootstrapOffer,
  isRateWindowEmpty
} from '../../../src/infrastructure/bootstrap/bootstrap-offer.utils'

const WAD = MathLib.WAD
const USDC = 1_000_000n
const DAY = 86_400n
const faceLimit = 500_000n * USDC
const cashBalance = 10n * faceLimit
const now = 1_000n
const maker: Address = '0x1111111111111111111111111111111111111111'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'77'.repeat(32)}`
const marketParams = (maturity: bigint) =>
  ({
    chainId: 8453,
    midnight: '0x2222222222222222222222222222222222222222',
    loanToken: '0x3333333333333333333333333333333333333333',
    collateralParams: [
      {
        token: '0x5555555555555555555555555555555555555555',
        lltv: 800_000_000_000_000_000n,
        liquidationCursor: 0n,
        oracle: '0x6666666666666666666666666666666666666666'
      }
    ],
    maturity,
    rcfThreshold: 0n,
    enterGate: '0x0000000000000000000000000000000000000000',
    liquidatorGate: '0x0000000000000000000000000000000000000000'
  }) as unknown as IMarketParams

const config = validateBootstrapConfig({
  marketId,
  creditTarget: faceLimit,
  acceptanceAssets: 0n,
  offerSize: faceLimit,
  premiumBps: 0n,
  maximumMarketExposure: faceLimit,
  maximumTotalExposure: faceLimit,
  minimumRateBps: 100n,
  maximumRateBps: 2_000n,
  autoRefill: false
})

// Midnight `take`: a maker buy pays floor(units × price), and a units-capped group admits units
// until `consumed` reaches `maxUnits`.
const fullTake = (offer: { tick: bigint; maxUnits: bigint }) => ({
  face: offer.maxUnits,
  cash: (offer.maxUnits * TickLib.tickToPrice(offer.tick)) / WAD
})

const takeBootstrap = (rateBps: bigint, timeToMaturity: bigint, availableCash = cashBalance) => {
  const decision = decidePositionBootstrap({
    config,
    position: {
      credit: 0n,
      cashBalance: availableCash,
      marketExposure: 0n,
      totalExposure: 0n
    },
    lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
    rate: { mode: 'static', rateBps, observationId: `static:${rateBps}` },
    initialTargetCompleted: false
  })
  if (decision.kind !== 'publish') throw new Error(`expected a publication, got ${decision.kind}`)
  const created = createBootstrapOffer({
    offer: decision.offer,
    market: { params: marketParams(now + timeToMaturity), tickSpacing: 4, continuousFee: 0 },
    maker,
    ratifier,
    now,
    minimumRateBps: config.minimumRateBps,
    maximumRateBps: config.maximumRateBps
  })
  return { created, ...fullTake(created) }
}

describe('face acquired by a fully taken bootstrap offer', () => {
  const cases = [300n, 500n, 1_200n].flatMap(rateBps =>
    [DAY, 30n * DAY, 365n * DAY, 5n * 365n * DAY].map(timeToMaturity => ({
      rateBps,
      timeToMaturity
    }))
  )

  test.each(cases)(
    'stays within face and cash limits at $rateBps bps over $timeToMaturity s',
    ({ rateBps, timeToMaturity }) => {
      const taken = takeBootstrap(rateBps, timeToMaturity)

      expect(taken.created).toMatchObject({ maxAssets: 0n, maxUnits: faceLimit })
      expect(taken.face).toBeLessThanOrEqual(faceLimit)
      expect(taken.cash).toBeLessThanOrEqual(cashBalance)
    }
  )

  test.each(cases)(
    'stays within cash when cash binds before face, at $rateBps bps over $timeToMaturity s',
    ({ rateBps, timeToMaturity }) => {
      const cash = 300_000n * USDC
      const taken = takeBootstrap(rateBps, timeToMaturity, cash)

      expect(taken.created).toMatchObject({ maxUnits: cash })
      expect(taken.cash).toBeLessThanOrEqual(cash)
    }
  )
})

describe('bootstrap offer rate range', () => {
  const create = (rateBps: bigint, timeToMaturity: bigint) =>
    createBootstrapOffer({
      offer: { marketId, assets: faceLimit, rateBps, referenceObservationId: `static:${rateBps}` },
      market: { params: marketParams(now + timeToMaturity), tickSpacing: 4, continuousFee: 0 },
      maker,
      ratifier,
      now,
      minimumRateBps: config.minimumRateBps,
      maximumRateBps: config.maximumRateBps
    })

  test.each([99n, 2_001n])('refuses a derived rate outside the range (%s BPS)', rateBps => {
    expect(() => create(rateBps, 30n * DAY)).toThrow(
      expect.objectContaining({ operation: 'rate-out-of-range' })
    )
  })

  test.each([100n, 2_000n])(
    'encodes a rate on a bound at a tick whose APR stays in range (%s BPS)',
    rateBps => {
      for (const timeToMaturity of [DAY, 30n * DAY, 365n * DAY]) {
        const apr = TickLib.tickToApr(create(rateBps, timeToMaturity).tick, timeToMaturity)
        expect(apr).toBeGreaterThanOrEqual(100n * 10n ** 14n)
        expect(apr).toBeLessThanOrEqual(2_000n * 10n ** 14n)
      }
    }
  )
})

describe('bootstrap offer tick spacing', () => {
  const create = (exactTick?: bigint) =>
    createBootstrapOffer({
      offer: { marketId, assets: faceLimit, rateBps: 500n, referenceObservationId: 'static:500' },
      market: { params: marketParams(now + 30n * DAY), tickSpacing: 2, continuousFee: 0 },
      maker,
      ratifier,
      now,
      ...(exactTick === undefined ? {} : { exactTick }),
      minimumRateBps: config.minimumRateBps,
      maximumRateBps: config.maximumRateBps
    })

  test('accepts a derived tick aligned to the market spacing but not to the default', () => {
    const { tick } = create()

    expect(tick % 2n).toBe(0n)
    expect(tick % 4n).not.toBe(0n)
  })

  test('accepts an exact tick aligned to the market spacing but not to the default', () => {
    expect(create(4_474n).tick).toBe(4_474n)
  })

  test('refuses an exact tick off the market spacing', () => {
    expect(() => create(4_475n)).toThrow(InvalidOfferParameterError)
  })
})

describe('bootstrap rate window', () => {
  const market = { params: marketParams(now + 365n * DAY), tickSpacing: 1 }
  const pinned = { now, minimumRateBps: 500n, maximumRateBps: 500n }

  test('is empty when the range is narrower than one tick', () => {
    expect(bootstrapRateWindowIsEmpty(market, pinned)).toBe(true)
  })

  test('holds a tick across the configured range', () => {
    expect(
      bootstrapRateWindowIsEmpty(market, {
        now,
        minimumRateBps: config.minimumRateBps,
        maximumRateBps: config.maximumRateBps
      })
    ).toBe(false)
  })

  test('leaves a matured market to the matured path', () => {
    expect(bootstrapRateWindowIsEmpty(market, { ...pinned, now: now + 365n * DAY })).toBe(false)
  })

  test('classifies the publication-block failure it predicts', () => {
    const create = () =>
      createBootstrapOffer({
        offer: { marketId, assets: faceLimit, rateBps: 500n, referenceObservationId: 'static:500' },
        market: { ...market, continuousFee: 0 },
        maker,
        ratifier,
        now,
        minimumRateBps: 500n,
        maximumRateBps: 500n
      })

    const thrown = (() => {
      try {
        return create()
      } catch (error) {
        return error
      }
    })()

    expect(thrown).toMatchObject({ operation: 'rate-window-empty' })
    expect(isRateWindowEmpty(thrown)).toBe(true)
    expect(isRateWindowEmpty(new Error('rate-window-empty'))).toBe(false)
  })
})
