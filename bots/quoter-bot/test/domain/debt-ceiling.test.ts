import { describe, expect, test } from 'vitest'

import { debtCeilingUnits, debtHeadroomUnits } from '../../src/domain/debt-ceiling'

const WAD = 10n ** 18n

describe('debtCeilingUnits', () => {
  test('is the lesser of the cap and what the loan-asset collateral supports', () => {
    expect(debtCeilingUnits({ maximumDebtUnits: 500n }, { assets: 1_000n, lltv: WAD })).toBe(500n)
    expect(debtCeilingUnits({ maximumDebtUnits: 5_000n }, { assets: 1_000n, lltv: WAD })).toBe(
      1_000n
    )
  })

  test('rounds the collateral-supported debt down, as Midnight isHealthy does', () => {
    expect(
      debtCeilingUnits({ maximumDebtUnits: 5_000n }, { assets: 999n, lltv: (WAD * 9n) / 10n })
    ).toBe(899n)
  })

  test('is zero without loan-asset collateral', () => {
    expect(debtCeilingUnits({ maximumDebtUnits: 500n })).toBe(0n)
  })
})

describe('debtHeadroomUnits', () => {
  const loanCollateral = { assets: 1_000n, lltv: WAD }

  test('is the ceiling less the debt already carried', () => {
    expect(debtHeadroomUnits({ maximumDebtUnits: 800n }, { debt: 300n, loanCollateral })).toBe(500n)
  })

  test('floors at zero once debt reaches the cap or the collateral', () => {
    expect(debtHeadroomUnits({ maximumDebtUnits: 200n }, { debt: 300n, loanCollateral })).toBe(0n)
    expect(debtHeadroomUnits({ maximumDebtUnits: 5_000n }, { debt: 1_001n, loanCollateral })).toBe(
      0n
    )
  })
})
