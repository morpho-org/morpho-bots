import { describe, expect, it } from 'vitest'

import { isBadDebtLiquidation, sizeOf, TransactionFilter } from '../../src/pollers/filter'
import {
  exitPrimaryItem,
  lendItem,
  liquidationItem,
  supplyCollateralItem,
  USER_ONE,
  USER_TWO
} from '../midnight/fixtures'

describe('sizeOf', () => {
  it('uses assets for trades and collateral, units for primary exits, repaid_units for liquidations', () => {
    expect(sizeOf(lendItem({ id: 'a', created_at: 1, assets: '123' }))).toBe(123n)
    expect(sizeOf(supplyCollateralItem({ id: 'b', assets: '77' }))).toBe(77n)
    expect(sizeOf(exitPrimaryItem({ id: 'c', units: '55' }))).toBe(55n)
    expect(sizeOf(liquidationItem({ id: 'd', repaid_units: '99' }))).toBe(99n)
  })
})

describe('isBadDebtLiquidation', () => {
  it('is true for bad_debt > 0 or pure realization, false otherwise', () => {
    expect(isBadDebtLiquidation(liquidationItem({ id: 'a', bad_debt: '1' }))).toBe(true)
    expect(
      isBadDebtLiquidation(liquidationItem({ id: 'b', pure_bad_debt_realization: true }))
    ).toBe(true)
    expect(isBadDebtLiquidation(liquidationItem({ id: 'c' }))).toBe(false)
    expect(isBadDebtLiquidation(lendItem({ id: 'd', created_at: 1 }))).toBe(false)
  })
})

describe('TransactionFilter', () => {
  it('passes everything when unconfigured', () => {
    const filter = new TransactionFilter({ minAssets: 0n, users: [] })
    expect(filter.matches(lendItem({ id: 'a', created_at: 1, assets: '1' }))).toBe(true)
  })

  it('applies the size threshold to the per-type size', () => {
    const filter = new TransactionFilter({ minAssets: 100n, users: [] })
    expect(filter.matches(lendItem({ id: 'a', created_at: 1, assets: '99' }))).toBe(false)
    expect(filter.matches(lendItem({ id: 'b', created_at: 1, assets: '100' }))).toBe(true)
    expect(filter.matches(exitPrimaryItem({ id: 'c', units: '99' }))).toBe(false)
    expect(filter.matches(exitPrimaryItem({ id: 'd', units: '100' }))).toBe(true)
  })

  it('matches the position owner case-insensitively when an allowlist is set', () => {
    const filter = new TransactionFilter({ minAssets: 0n, users: [USER_ONE] })
    expect(
      filter.matches(lendItem({ id: 'a', created_at: 1, account: USER_ONE.toLowerCase() }))
    ).toBe(true)
    expect(filter.matches(lendItem({ id: 'b', created_at: 1, account: USER_TWO }))).toBe(false)
  })

  it('lets bad-debt liquidations bypass both size and user filters', () => {
    const filter = new TransactionFilter({ minAssets: 10_000n, users: [USER_ONE] })
    const badDebt = liquidationItem({
      id: 'a',
      bad_debt: '1',
      repaid_units: '1',
      account: USER_TWO
    })
    expect(filter.matches(badDebt)).toBe(true)
    const clean = liquidationItem({ id: 'b', repaid_units: '1', account: USER_TWO })
    expect(filter.matches(clean)).toBe(false)
  })
})
