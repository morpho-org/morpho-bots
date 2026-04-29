import { describe, expect, it } from 'bun:test'

import {
  formatBPSPercent,
  formatInt256,
  formatters,
  formatTokenBalance,
  formatTokenBalanceFull,
  formatUint256,
  formatUint256Percent,
  formatUsdValue
} from '../../src/helpers/formatters'

describe('formatters', () => {
  it('should have formatters object with morpho-ts methods', () => {
    expect(formatters).toBeDefined()
    expect(formatters).toHaveProperty('commas')
    expect(formatters).toHaveProperty('number')
    expect(formatters).toHaveProperty('short')
  })
})

describe('formatUint256', () => {
  it('should be a formatter object with proper configuration', () => {
    expect(formatUint256).toBeDefined()
    expect(typeof formatUint256).toBe('function')
  })

  it('should format large bigint values', () => {
    const result = formatUint256(1000000000000000000n, 18)

    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('should handle zero', () => {
    const result = formatUint256(0n, 18)

    expect(typeof result).toBe('string')
    expect(result).toBe('0.00')
  })

  it('should format with decimal values', () => {
    const result = formatUint256(123456789000000000n, 18)

    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatInt256', () => {
  it('should be a formatter object with proper configuration', () => {
    expect(formatInt256).toBeDefined()
    expect(typeof formatInt256).toBe('function')
  })

  it('should preserve negative bigint values', () => {
    const result = formatInt256(-123456789n, 6)

    expect(typeof result).toBe('string')
    expect(result).toContain('-')
  })
})

describe('formatUint256Percent', () => {
  it('should format as percentage with default 2 digits', () => {
    const result = formatUint256Percent(5000000000000000n)

    expect(result).toContain('%')
    expect(result).toContain('0.5')
  })

  it('should handle custom digits', () => {
    const result = formatUint256Percent(123456789000000n, 4)

    expect(result).toContain('%')
  })

  it('should handle trailing zeros when enabled', () => {
    const result = formatUint256Percent(5000000000000000n, 2, true)

    expect(result).toContain('%')
    expect(result).toContain('0.50')
  })

  it('should not have trailing zeros by default', () => {
    const result = formatUint256Percent(5000000000000000n, 2, false)

    expect(result).toContain('%')
    expect(result).toBe('0.5%')
  })

  it('should handle zero', () => {
    const result = formatUint256Percent(0n)

    expect(result).toContain('%')
    expect(result).toContain('0')
  })

  it('should handle 100%', () => {
    const result = formatUint256Percent(10000000000000000n)

    expect(result).toContain('%')
    expect(result).toContain('1')
  })
})

describe('formatBPSPercent', () => {
  it('should format bigint basis points as percentage', () => {
    const result = formatBPSPercent(500n)

    expect(result).toContain('%')
    expect(result).toContain('5')
  })

  it('should format number basis points as percentage', () => {
    const result = formatBPSPercent(250)

    expect(result).toContain('%')
    expect(result).toContain('2.5')
  })

  it('should handle custom precision', () => {
    const result = formatBPSPercent(12345n, { precision: 4 })

    expect(result).toContain('%')
  })

  it('should handle trailing zeros option', () => {
    const result = formatBPSPercent(500n, { trailingZeros: true })

    expect(result).toContain('%')
    expect(result).toContain('5.00')
  })

  it('should not have trailing zeros by default', () => {
    const result = formatBPSPercent(500n)

    expect(result).toBe('5%')
  })

  it('should handle zero', () => {
    const result = formatBPSPercent(0n)

    expect(result).toContain('%')
    expect(result).toContain('0')
  })

  it('should handle 100% (10000 bps)', () => {
    const result = formatBPSPercent(10000n)

    expect(result).toContain('%')
    expect(result).toContain('100')
  })

  it('should handle fractional basis points', () => {
    const result = formatBPSPercent(123n, { precision: 3 })

    expect(result).toContain('%')
    expect(result).toContain('1.23')
  })

  it('should handle both precision and trailingZeros options together', () => {
    const result = formatBPSPercent(500n, { precision: 3, trailingZeros: true })

    expect(result).toContain('%')
    expect(result).toContain('5.000')
  })
})

describe('formatTokenBalance', () => {
  it('should format token balance with symbol', () => {
    const result = formatTokenBalance(1000000000000000000n, 18, 'ETH')

    expect(result).toContain('ETH')
    expect(result).toContain('1')
  })

  it('should handle custom decimals', () => {
    const result = formatTokenBalance(1000000n, 6, 'USDC')

    expect(result).toContain('USDC')
    expect(result).toContain('1')
  })

  it('should handle null value with default', () => {
    const result = formatTokenBalance(null, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should handle undefined value with default', () => {
    const result = formatTokenBalance(undefined, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should handle null decimals with default 18', () => {
    const result = formatTokenBalance(1000000000000000000n, null, 'ETH')

    expect(result).toContain('ETH')
  })

  it('should handle undefined decimals with default 18', () => {
    const result = formatTokenBalance(1000000000000000000n, undefined, 'ETH')

    expect(result).toContain('ETH')
  })

  it('should handle null symbol with empty string', () => {
    const result = formatTokenBalance(1000000000000000000n, 18, null)

    expect(result).toContain('1')
  })

  it('should handle undefined symbol with empty string', () => {
    const result = formatTokenBalance(1000000000000000000n, 18, undefined)

    expect(result).toContain('1')
  })

  it('should handle zero balance', () => {
    const result = formatTokenBalance(0n, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should handle small values with minimum threshold', () => {
    const result = formatTokenBalance(10000000000000n, 18, 'ETH')

    expect(result).toContain('ETH')
  })

  it('should use short format for large values', () => {
    const result = formatTokenBalance(1000000000000000000000n, 18, 'ETH')

    expect(result).toContain('ETH')
    expect(typeof result).toBe('string')
  })

  it('should format with 2 decimal digits', () => {
    const result = formatTokenBalance(1230000000000000000n, 18, 'ETH')

    expect(result).toContain('1.23')
    expect(result).toContain('ETH')
  })
})

describe('formatTokenBalanceFull', () => {
  it('should format values with thousand separators', () => {
    const result = formatTokenBalanceFull(100000_000000n, 6, 'USDC')

    expect(result).toBe('100,000 USDC')
  })

  it('should format large values without abbreviation', () => {
    const result = formatTokenBalanceFull(1000000_000000000000000000n, 18, 'ETH')

    expect(result).toBe('1,000,000 ETH')
  })

  it('should preserve decimal formatting', () => {
    const result = formatTokenBalanceFull(1234_560000000000000000n, 18, 'ETH')

    expect(result).toBe('1,234.56 ETH')
  })

  it('should handle null value with default', () => {
    const result = formatTokenBalanceFull(null, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should handle undefined value with default', () => {
    const result = formatTokenBalanceFull(undefined, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should handle zero balance', () => {
    const result = formatTokenBalanceFull(0n, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should respect custom digit precision', () => {
    const result = formatTokenBalanceFull(1234_567800000000000000n, 18, 'ETH', 4)

    expect(result).toBe('1,234.5678 ETH')
  })

  it('should display really small values with enough digit precision', () => {
    // 0.001 ETH = 1e15 wei (18 decimals) — needs at least 3 digits to show
    const result = formatTokenBalanceFull(1000000000000000n, 18, 'ETH', 4)

    expect(result).toBe('0.001 ETH')
  })

  it('should round really small values to zero at default precision', () => {
    // 0.001 ETH rounds to 0 at 2 digits
    const result = formatTokenBalanceFull(1000000000000000n, 18, 'ETH')

    expect(result).toBe('0 ETH')
  })

  it('should display dust balance with enough digit precision', () => {
    // 0.000001 USDC = 1 raw unit (6 decimals)
    const result = formatTokenBalanceFull(1n, 6, 'USDC', 6)

    expect(result).toBe('0.000001 USDC')
  })
})

describe('formatUsdValue', () => {
  it('should format number value with dollar sign', () => {
    const result = formatUsdValue(1234.56)

    expect(result).toContain('$')
    expect(result).toContain('1')
  })

  it('should format string value with dollar sign', () => {
    const result = formatUsdValue('5678.90')

    expect(result).toContain('$')
    expect(result).toContain('5')
  })

  it('should handle null with default', () => {
    const result = formatUsdValue(null)

    expect(result).toBe('$0')
  })

  it('should handle empty string', () => {
    const result = formatUsdValue('')

    expect(result).toBe('$0')
  })

  it('should handle zero', () => {
    const result = formatUsdValue(0)

    expect(result).toBe('$0')
  })

  it('should use short format for large values', () => {
    const result = formatUsdValue(1000000)

    expect(result).toContain('$')
    expect(result).toContain('M')
  })

  it('should use short format for billions', () => {
    const result = formatUsdValue(1000000000)

    expect(result).toContain('$')
    expect(result).toContain('B')
  })

  it('should format with 2 decimal digits', () => {
    const result = formatUsdValue(123.45)

    expect(result).toContain('$')
    expect(result).toContain('123')
  })

  it('should handle negative values', () => {
    const result = formatUsdValue(-100)

    expect(result).toContain('$')
    expect(result).toContain('-')
  })

  it('should handle very small values', () => {
    const result = formatUsdValue(0.001)

    expect(typeof result).toBe('string')
    expect(result).toContain('$')
  })
})
