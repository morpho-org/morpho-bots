import { Time } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import {
  MATURITY_PREMIUM_YEAR_SECONDS,
  maturityPremiumConfigIssue,
  resolveMaturityPremiumBps
} from '../../src/domain/maturity-premium'

const DAY_SECONDS = 86_400n

describe('MATURITY_PREMIUM_YEAR_SECONDS', () => {
  test('matches the SDK annualization used by APR and tick derivation', () => {
    expect(MATURITY_PREMIUM_YEAR_SECONDS).toBe(Time.s.from.y(1n))
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
