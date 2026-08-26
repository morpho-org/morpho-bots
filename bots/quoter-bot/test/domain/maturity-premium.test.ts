import { Time } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import {
  MATURITY_PREMIUM_MAX_MATURITY_SECONDS,
  MATURITY_PREMIUM_YEAR_SECONDS,
  hasAttainableMaturityPremiumBps,
  highestReachableMaturityPremiumBps,
  maturityPremiumConfigIssue,
  resolveMaturityPremiumBps
} from '../../src/domain/maturity-premium'

const DAY_SECONDS = 86_400n

describe('MATURITY_PREMIUM_YEAR_SECONDS', () => {
  test('matches the SDK annualization used by APR and tick derivation', () => {
    expect(MATURITY_PREMIUM_YEAR_SECONDS).toBe(Time.s.from.y(1n))
  })
})

describe('MATURITY_PREMIUM_MAX_MATURITY_SECONDS', () => {
  test('matches the protocol MaturityTooFar horizon of one hundred 365-day years', () => {
    expect(MATURITY_PREMIUM_MAX_MATURITY_SECONDS).toBe(Time.s.from.y(100n))
  })
})

describe('highestReachableMaturityPremiumBps', () => {
  test('resolves the premium at the protocol horizon without a cap', () => {
    expect(highestReachableMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n })).toBe(
      12_000n
    )
  })

  test('returns a binding cap below the horizon premium', () => {
    expect(
      highestReachableMaturityPremiumBps({
        shape: 'linear',
        premiumPerYearBps: 120n,
        maximumPremiumBps: 300n
      })
    ).toBe(300n)
  })

  test('ignores a cap the horizon premium never reaches', () => {
    expect(
      highestReachableMaturityPremiumBps({
        shape: 'linear',
        premiumPerYearBps: 1n,
        maximumPremiumBps: 300n
      })
    ).toBe(100n)
  })
})

describe('maturityPremiumConfigIssue', () => {
  test('accepts a positive slope without a cap', () => {
    expect(maturityPremiumConfigIssue({ shape: 'linear', premiumPerYearBps: 120n })).toBeUndefined()
  })

  test('accepts a positive slope with a positive cap', () => {
    expect(
      maturityPremiumConfigIssue({
        shape: 'linear',
        premiumPerYearBps: 120n,
        maximumPremiumBps: 300n
      })
    ).toBeUndefined()
  })

  test.each([0n, -120n])('rejects the non-positive slope %s', premiumPerYearBps => {
    expect(maturityPremiumConfigIssue({ shape: 'linear', premiumPerYearBps })).toEqual({
      field: 'maturityPremium.premiumPerYearBps',
      reason: 'must be positive'
    })
  })

  test.each([0n, -1n])('rejects the non-positive cap %s', maximumPremiumBps => {
    expect(
      maturityPremiumConfigIssue({
        shape: 'linear',
        premiumPerYearBps: 120n,
        maximumPremiumBps
      })
    ).toEqual({ field: 'maturityPremium.maximumPremiumBps', reason: 'must be positive' })
  })
})

describe('resolveMaturityPremiumBps', () => {
  test('scales the premium linearly with time to maturity', () => {
    expect(
      resolveMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: 120n },
        MATURITY_PREMIUM_YEAR_SECONDS / 2n
      )
    ).toBe(60n)
    expect(
      resolveMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: 120n },
        2n * MATURITY_PREMIUM_YEAR_SECONDS
      )
    ).toBe(240n)
  })

  test('floors fractional basis points so slow decay cannot churn offers', () => {
    expect(
      resolveMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n }, 14n * DAY_SECONDS)
    ).toBe(4n)
    expect(
      resolveMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n }, DAY_SECONDS)
    ).toBe(0n)
  })

  test('applies the inclusive cap only above it', () => {
    const config = { shape: 'linear' as const, premiumPerYearBps: 120n, maximumPremiumBps: 100n }
    expect(resolveMaturityPremiumBps(config, MATURITY_PREMIUM_YEAR_SECONDS / 2n)).toBe(60n)
    expect(resolveMaturityPremiumBps(config, 2n * MATURITY_PREMIUM_YEAR_SECONDS)).toBe(100n)
  })

  test.each([0n, -1n, -MATURITY_PREMIUM_YEAR_SECONDS])(
    'contributes zero premium at or past maturity for %s seconds',
    secondsToMaturity => {
      expect(
        resolveMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n }, secondsToMaturity)
      ).toBe(0n)
    }
  )
})

describe('hasAttainableMaturityPremiumBps', () => {
  const perSecondSlope = 1_000n * MATURITY_PREMIUM_YEAR_SECONDS

  test('accepts any window containing the zero premium attained at maturity', () => {
    expect(
      hasAttainableMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n }, -50n, 0n)
    ).toBe(true)
    expect(
      hasAttainableMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: perSecondSlope },
        0n,
        700n
      )
    ).toBe(true)
  })

  test('accepts a one-BPS-stepping slope that walks into the window', () => {
    expect(
      hasAttainableMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n }, 100n, 700n)
    ).toBe(true)
  })

  test('rejects a slope whose integer steps jump over the whole window', () => {
    expect(
      hasAttainableMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: perSecondSlope },
        100n,
        700n
      )
    ).toBe(false)
  })

  test('accepts a coarse slope whose first step lands exactly on the window edge', () => {
    expect(
      hasAttainableMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: perSecondSlope },
        100n,
        1_000n
      )
    ).toBe(true)
  })

  test('accepts a coarse slope saturating onto a cap inside the window', () => {
    expect(
      hasAttainableMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: perSecondSlope, maximumPremiumBps: 500n },
        100n,
        700n
      )
    ).toBe(true)
  })

  test('rejects a ceiling below the window and a window below zero', () => {
    expect(
      hasAttainableMaturityPremiumBps(
        { shape: 'linear', premiumPerYearBps: 120n, maximumPremiumBps: 50n },
        100n,
        700n
      )
    ).toBe(false)
    expect(
      hasAttainableMaturityPremiumBps({ shape: 'linear', premiumPerYearBps: 120n }, -700n, -100n)
    ).toBe(false)
  })
})
