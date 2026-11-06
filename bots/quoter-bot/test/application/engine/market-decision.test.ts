import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { Observed } from '../../../src/application/engine/decision'
import type { LadderReading, ReferenceReading } from '../../../src/application/engine/readings'
import type { LadderConfig } from '../../../src/domain/ladder'

import { prepareRequest } from '../../../src/application/engine/market-decision'
import { validateLadderConfig } from '../../../src/domain/ladder'

const marketId: Hex = `0x${'55'.repeat(32)}`
const YEAR = 31_536_000n
const OBSERVED_AT = 1_800_000_000n

const config = (overrides: Partial<LadderConfig> = {}) =>
  validateLadderConfig({
    marketId,
    quotePremiumBps: 0n,
    spreadBps: 200n,
    stepBps: 100n,
    rungCount: 3,
    sizeSkewBps: 0n,
    lowerRateBudgetAssets: 10n,
    higherRateBudgetAssets: 10n,
    targetMarketExposureAssets: 20n,
    maximumTotalExposureAssets: 20n,
    minimumOfferAssets: 1n,
    groupMode: 'shared-rung',
    loopIntervalSeconds: 3600,
    bookCrossedCooldownSeconds: 180,
    movementToleranceBps: 10n,
    minimumRateBps: 0n,
    maximumRateBps: 2_000n,
    ...overrides
  })

const reading = (secondsToMaturity: bigint): LadderReading => ({
  strategy: 'ladder',
  marketId,
  block: 100,
  guard: { ok: true, value: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true } },
  active: { ok: true, value: { consumption: [] } },
  market: {
    ok: true,
    value: {
      lowerRateCapacityAssets: 20n,
      higherRateCapacityAssets: 20n,
      targetMarketCapacityAssets: 20n,
      maximumTotalCapacityAssets: 20n,
      maturityTimestamp: OBSERVED_AT + secondsToMaturity,
      observedTimestamp: OBSERVED_AT
    }
  }
})

const reference: Observed<ReferenceReading> = {
  status: 'ready',
  value: { ok: true, value: { mode: 'static', rateBps: 500n, observationId: 'static:500' } }
}

const centerOf = (request: ReturnType<typeof prepareRequest>) =>
  (request as { desired: { centerRateBps: bigint } }).desired.centerRateBps

describe('prepareRequest', () => {
  test.each([
    ['a year from maturity', YEAR, 620n],
    ['half a year from maturity', YEAR / 2n, 560n]
  ])('prices the maturity premium %s from the reading block', (_, seconds, center) => {
    const premium = config({ maturityPremium: { shape: 'linear', premiumPerYearBps: 120n } })
    const request = prepareRequest(reading(seconds), premium, {
      reference,
      view: { live: [] },
      crossings: {},
      completed: false
    })
    expect(centerOf(request)).toBe(center)
  })

  test('adds no premium to a market without a configured maturity premium', () => {
    const request = prepareRequest(reading(YEAR), config(), {
      reference,
      view: { live: [] },
      crossings: {},
      completed: false
    })
    expect(centerOf(request)).toBe(500n)
  })
})
