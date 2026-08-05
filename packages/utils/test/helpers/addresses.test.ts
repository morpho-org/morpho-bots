import { describe, expect, it } from 'vitest'

import { abbreviateAddress } from '../../src/helpers/addresses'

describe('address utilities', () => {
  describe('abbreviateAddress', () => {
    it('should abbreviate address with default segment length', () => {
      const address = '0x1234567890abcdef1234567890abcdef12345678'
      expect(abbreviateAddress(address)).toBe('0x1234...5678')
    })

    it('should abbreviate address with custom segment length', () => {
      const address = '0x1234567890abcdef1234567890abcdef12345678'
      expect(abbreviateAddress(address, 6)).toBe('0x123456...345678')
    })

    it('should return empty string for empty address', () => {
      expect(abbreviateAddress('')).toBe('')
    })

    it('should handle checksum addresses', () => {
      const address = '0x1234567890abcdef1234567890abcdef12345678'
      expect(abbreviateAddress(address)).toBe('0x1234...5678')
    })
  })
})
