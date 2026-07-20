import { maxUint256 } from 'viem'
import { describe, expect, it } from 'vitest'

import { addressSchema, createOnchainAmountSchema } from '../../src/helpers/schema'

describe('addressSchema', () => {
  it('should accept valid Ethereum addresses', () => {
    const validAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb4'
    const checksummed = '0x742d35CC6634c0532925a3B844bC9e7595F0BeB4'

    expect(addressSchema.parse(validAddress)).toBe(checksummed)
  })

  it('should accept addresses with lowercase and return checksummed', () => {
    const lowercaseAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb4'
    const checksummed = '0x742d35CC6634c0532925a3B844bC9e7595F0BeB4'

    expect(addressSchema.parse(lowercaseAddress)).toBe(checksummed)
  })

  it('should accept addresses with uppercase and return checksummed', () => {
    const uppercaseAddress = '0x742D35CC6634C0532925A3B844BC9E7595F0BEB4'
    const checksummed = '0x742d35CC6634c0532925a3B844bC9e7595F0BeB4'

    expect(addressSchema.parse(uppercaseAddress)).toBe(checksummed)
  })

  it('should trim whitespace and return checksummed', () => {
    const addressWithSpaces = '  0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb4  '
    const checksummed = '0x742d35CC6634c0532925a3B844bC9e7595F0BeB4'

    expect(addressSchema.parse(addressWithSpaces)).toBe(checksummed)
  })

  it('should reject empty string', () => {
    expect(() => addressSchema.parse('')).toThrow('Missing address')
  })

  it('should reject whitespace-only string', () => {
    expect(() => addressSchema.parse('   ')).toThrow('Missing address')
  })

  it('should reject invalid address format', () => {
    expect(() => addressSchema.parse('invalid')).toThrow('Invalid address')
    expect(() => addressSchema.parse('0x123')).toThrow('Invalid address')
  })

  it('should reject address without 0x prefix', () => {
    expect(() => addressSchema.parse('742d35Cc6634C0532925a3b844Bc9e7595f0bEb4')).toThrow(
      'Invalid address'
    )
  })

  it('should reject address with wrong length', () => {
    expect(() => addressSchema.parse('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb')).toThrow(
      'Invalid address'
    )
  })

  it('should reject address with invalid characters', () => {
    expect(() => addressSchema.parse('0x742d35Gc6634C0532925a3b844Bc9e7595f0bEb4')).toThrow(
      'Invalid address'
    )
  })

  it('should accept the zero address', () => {
    const zeroAddress = '0x0000000000000000000000000000000000000000'

    expect(addressSchema.parse(zeroAddress)).toBe(zeroAddress)
  })
})

describe('createOnchainAmountSchema', () => {
  describe('basic parsing (18 decimals)', () => {
    const schema = createOnchainAmountSchema({ decimals: 18 })

    it('should parse valid amounts', () => {
      // Integers
      expect(schema.parse('1')).toBe(1_000_000_000_000_000_000n)
      expect(schema.parse('100')).toBe(100_000_000_000_000_000_000n)

      // Decimals
      expect(schema.parse('1.5')).toBe(1_500_000_000_000_000_000n)
      expect(schema.parse('0.001')).toBe(1_000_000_000_000_000n)
      expect(schema.parse('0.000000000000000001')).toBe(1n) // 1 wei

      // Edge formats
      expect(schema.parse('1.0')).toBe(1_000_000_000_000_000_000n) // Trailing zeros
      expect(schema.parse('.5')).toBe(500_000_000_000_000_000n) // Leading dot
      expect(schema.parse('5.')).toBe(5_000_000_000_000_000_000n) // Trailing dot
      expect(schema.parse('  1.5  ')).toBe(1_500_000_000_000_000_000n) // Whitespace
    })

    it('should reject zero and empty values (default min=1n)', () => {
      // parseUnits treats "", ".", and "0" as 0n, which fails min check
      expect(schema.safeParse('').success).toBe(false)
      expect(schema.safeParse('   ').success).toBe(false)
      expect(schema.safeParse('.').success).toBe(false)
      expect(schema.safeParse('0').success).toBe(false)
      expect(schema.safeParse('0.0').success).toBe(false)
    })

    it('should reject invalid formats', () => {
      expect(schema.safeParse('abc').success).toBe(false)
      expect(schema.safeParse('1.2.3').success).toBe(false)
      expect(schema.safeParse('1,000').success).toBe(false)
      expect(schema.safeParse('1e5').success).toBe(false) // Scientific notation
      expect(schema.safeParse('12abc').success).toBe(false) // Trailing text
      expect(schema.safeParse('-1').success).toBe(false) // Negative
      expect(schema.safeParse('$1').success).toBe(false) // Special chars
    })

    it('should reject amounts exceeding decimal precision', () => {
      const result = schema.safeParse('0.0000000000000000001') // 19 decimals
      expect(result.success).toBe(false)
    })
  })

  describe('different decimal precisions', () => {
    it('should work with 6 decimals (USDC-like)', () => {
      const schema = createOnchainAmountSchema({ decimals: 6 })

      expect(schema.parse('1')).toBe(1_000_000n)
      expect(schema.parse('1.5')).toBe(1_500_000n)
      expect(schema.parse('0.000001')).toBe(1n)
      expect(schema.parse('123.456789')).toBe(123_456_789n)

      // Exceeding precision returns 0n, fails min check
      expect(schema.safeParse('0.0000001').success).toBe(false)
    })

    it('should work with 0 decimals (integer tokens)', () => {
      const schema = createOnchainAmountSchema({ decimals: 0 })

      expect(schema.parse('1')).toBe(1n)
      expect(schema.parse('100')).toBe(100n)
      expect(schema.parse('1.0')).toBe(1n)

      // Rounds decimals
      expect(schema.parse('1.5')).toBe(2n)
      expect(schema.parse('1.4')).toBe(1n)
    })
  })

  describe('custom min/max validation', () => {
    it('should enforce custom minimum with error message', () => {
      const schema = createOnchainAmountSchema({
        decimals: 18,
        min: 10_000_000_000_000_000_000n, // 10 tokens
        minErrorMessage: 'Minimum is 10 tokens'
      })

      expect(schema.parse('10')).toBe(10_000_000_000_000_000_000n)
      expect(schema.parse('100')).toBe(100_000_000_000_000_000_000n)

      const result = schema.safeParse('9.999')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Minimum is 10 tokens')
      }
    })

    it('should enforce custom maximum with error message', () => {
      const schema = createOnchainAmountSchema({
        decimals: 18,
        max: 1_000_000_000_000_000_000_000n, // 1000 tokens
        maxErrorMessage: 'Maximum is 1000 tokens'
      })

      expect(schema.parse('1')).toBe(1_000_000_000_000_000_000n)
      expect(schema.parse('1000')).toBe(1_000_000_000_000_000_000_000n)

      const result = schema.safeParse('1000.001')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Maximum is 1000 tokens')
      }
    })

    it('should enforce both min and max', () => {
      const schema = createOnchainAmountSchema({
        decimals: 18,
        min: 100_000_000_000_000_000n, // 0.1
        max: 100_000_000_000_000_000_000n // 100
      })

      expect(schema.parse('0.1')).toBe(100_000_000_000_000_000n)
      expect(schema.parse('50')).toBe(50_000_000_000_000_000_000n)
      expect(schema.parse('100')).toBe(100_000_000_000_000_000_000n)

      expect(schema.safeParse('0.09').success).toBe(false)
      expect(schema.safeParse('100.1').success).toBe(false)
    })
  })

  describe('allowing zero (min=0n)', () => {
    const schema = createOnchainAmountSchema({
      decimals: 18,
      min: 0n
    })

    it('should accept zero and empty values', () => {
      // When min=0n, parseUnits("") → 0n is valid
      expect(schema.parse('0')).toBe(0n)
      expect(schema.parse('0.0')).toBe(0n)
      expect(schema.parse('')).toBe(0n)
      expect(schema.parse('.')).toBe(0n)
    })

    it('should accept positive amounts', () => {
      expect(schema.parse('1')).toBe(1_000_000_000_000_000_000n)
    })

    it('should still reject negative amounts', () => {
      expect(schema.safeParse('-1').success).toBe(false)
    })
  })

  describe('boundary values', () => {
    it('should support maxUint256', () => {
      const schema = createOnchainAmountSchema({
        decimals: 18,
        max: maxUint256
      })

      const largeAmount = '1000000000000000000' // 1e18 tokens
      expect(schema.parse(largeAmount)).toBe(1_000_000_000_000_000_000_000_000_000_000_000_000n)
    })
  })
})
