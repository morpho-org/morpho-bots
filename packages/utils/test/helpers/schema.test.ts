import { describe, expect, it } from 'bun:test'

import { addressSchema } from '../../src/helpers/schema'

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
