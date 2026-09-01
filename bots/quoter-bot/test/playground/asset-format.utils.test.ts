import { describe, expect, test } from 'vitest'

import {
  DEFAULT_ASSET_DECIMALS,
  MAXIMUM_ASSET_DECIMALS,
  assetFormatter,
  formatAssetAmount,
  resolveDecimals
} from '../../playground/asset-format.utils'

describe('formatAssetAmount', () => {
  test('renders whole token units, grouped', () => {
    expect(formatAssetAmount('10000000000', 6)).toBe('10,000')
    expect(formatAssetAmount('101000000', 6)).toBe('101')
    expect(formatAssetAmount('10000000000', 8)).toBe('100')
    expect(formatAssetAmount('123456789012345678901234567890', 18)).toBe('123,456,789,012')
  })

  test('rounds the fractional units away to the nearest whole unit', () => {
    expect(formatAssetAmount('2011326045', 6)).toBe('2,011')
    expect(formatAssetAmount('2011726045', 6)).toBe('2,012')
    expect(formatAssetAmount('1500000', 6)).toBe('2')
    expect(formatAssetAmount('1499999', 6)).toBe('1')
  })

  test('never renders a non-zero amount as zero', () => {
    expect(formatAssetAmount('1', 18)).toBe('<1')
    expect(formatAssetAmount('499999', 6)).toBe('<1')
    expect(formatAssetAmount('0', 18)).toBe('0')
    expect(formatAssetAmount('0', 0)).toBe('0')
  })

  test('renders the exact integer at zero decimals', () => {
    expect(formatAssetAmount('10000000000', 0)).toBe('10,000,000,000')
    expect(formatAssetAmount('7', 0)).toBe('7')
  })

  test('leaves values it cannot scale untouched', () => {
    expect(formatAssetAmount('not-a-number', 6)).toBe('not-a-number')
    expect(formatAssetAmount('1.5', 6)).toBe('1.5')
    expect(formatAssetAmount('100', -1)).toBe('100')
    expect(formatAssetAmount('100', 1.5)).toBe('100')
  })
})

describe('resolveDecimals', () => {
  test('accepts whole numbers within the inclusive bound', () => {
    expect(resolveDecimals('0')).toBe(0)
    expect(resolveDecimals('6')).toBe(6)
    expect(resolveDecimals(' 18 ')).toBe(18)
    expect(resolveDecimals(String(MAXIMUM_ASSET_DECIMALS))).toBe(MAXIMUM_ASSET_DECIMALS)
  })

  test('resolves the USDC default the panel starts from', () => {
    expect(resolveDecimals(DEFAULT_ASSET_DECIMALS)).toBe(6)
  })

  test('rejects a cleared entry and every unusable entry', () => {
    for (const value of ['', 'abc', '-1', '6.5', '1e3', '37'])
      expect(resolveDecimals(value)).toBeUndefined()
  })
})

describe('assetFormatter', () => {
  test('applies one scale to every amount', () => {
    const format = assetFormatter('6')
    expect(format('10000000000')).toBe('10,000')
    expect(format('500000000')).toBe('500')
  })

  test('renders whole USDC units from the default entry', () => {
    expect(assetFormatter(DEFAULT_ASSET_DECIMALS)('10000000000')).toBe('10,000')
  })

  test('renders raw amounts while no usable scale is supplied', () => {
    for (const entry of ['', 'abc', '37'])
      expect(assetFormatter(entry)('10000000000')).toBe('10000000000')
  })

  test('changes only the rendering, whatever the scale', () => {
    const raw = '18000000000'
    expect(assetFormatter('0')(raw)).toBe('18,000,000,000')
    expect(assetFormatter('6')(raw)).toBe('18,000')
    expect(assetFormatter('8')(raw)).toBe('180')
    expect(assetFormatter('18')(raw)).toBe('<1')
  })
})
