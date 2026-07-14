import { describe, expect, it } from 'bun:test'

import {
  addressListEnv,
  boolEnv,
  intEnv,
  ladderEnv,
  numberEnv,
  required,
  resolveLiquidatorAddress
} from '../src/env'

// Reused across the address tests — lowercase input and its checksummed form (same pair as
// schema.test.ts, so the two stay in agreement).
const ADDRESS = '0x742d35cc6634c0532925a3b844bc9e7595f0beb4'
const CHECKSUMMED = '0x742d35CC6634c0532925a3B844bC9e7595F0BeB4'

describe('required', () => {
  it('returns a present value', () => {
    expect(required({ FOO: 'bar' }, 'FOO')).toBe('bar')
  })

  it('throws on a missing or blank var', () => {
    expect(() => required({}, 'FOO')).toThrow('Missing required env var: FOO')
    expect(() => required({ FOO: '   ' }, 'FOO')).toThrow('Missing required env var: FOO')
  })
})

describe('intEnv', () => {
  it('returns the default when unset', () => {
    expect(intEnv({}, 'N', 5)).toBe(5)
  })

  it('parses a non-negative integer', () => {
    expect(intEnv({ N: '42' }, 'N', 5)).toBe(42)
  })

  it('rejects decimal/hex/exponent forms', () => {
    expect(() => intEnv({ N: '1.5' }, 'N', 5)).toThrow('non-negative integer')
    expect(() => intEnv({ N: '0x1' }, 'N', 5)).toThrow('non-negative integer')
    expect(() => intEnv({ N: '1e3' }, 'N', 5)).toThrow('non-negative integer')
  })

  it('enforces min/max bounds', () => {
    expect(() => intEnv({ N: '0' }, 'N', 5, { min: 1 })).toThrow('must be >= 1')
    expect(() => intEnv({ N: '11' }, 'N', 5, { max: 10 })).toThrow('must be <= 10')
  })
})

describe('numberEnv', () => {
  it('returns the default when unset', () => {
    expect(numberEnv({}, 'X', 1.02)).toBe(1.02)
  })

  it('parses a positive decimal', () => {
    expect(numberEnv({ X: '1.5' }, 'X', 1)).toBe(1.5)
  })

  it('rejects non-positive or malformed values', () => {
    expect(() => numberEnv({ X: '0' }, 'X', 1)).toThrow('positive number')
    expect(() => numberEnv({ X: 'abc' }, 'X', 1)).toThrow('positive number')
  })

  it('enforces the min bound', () => {
    expect(() => numberEnv({ X: '0.5' }, 'X', 1, { min: 1 })).toThrow('must be >= 1')
  })
})

describe('boolEnv', () => {
  it('returns the default when unset', () => {
    expect(boolEnv({}, 'B', true)).toBe(true)
  })

  it('parses true/false case-insensitively', () => {
    expect(boolEnv({ B: 'TRUE' }, 'B', false)).toBe(true)
    expect(boolEnv({ B: 'false' }, 'B', true)).toBe(false)
  })

  it('rejects any other value', () => {
    expect(() => boolEnv({ B: 'yes' }, 'B', false)).toThrow('"true" or "false"')
  })
})

describe('ladderEnv', () => {
  it('returns the default when unset', () => {
    expect(ladderEnv({}, 'L', ['1', '2'])).toEqual(['1', '2'])
  })

  it('splits and keeps raw string tokens (trimmed)', () => {
    expect(ladderEnv({ L: '0.01, 0.1 , 1' }, 'L', [])).toEqual(['0.01', '0.1', '1'])
  })

  it('rejects any non-positive or malformed element', () => {
    expect(() => ladderEnv({ L: '1,0' }, 'L', [])).toThrow('comma-separated positive numbers')
    expect(() => ladderEnv({ L: '1,x' }, 'L', [])).toThrow('comma-separated positive numbers')
  })
})

describe('addressListEnv', () => {
  it('returns [] when unset', () => {
    expect(addressListEnv({}, 'A')).toEqual([])
  })

  it('parses and checksums a comma-separated list', () => {
    expect(addressListEnv({ A: `${ADDRESS}, ${ADDRESS}` }, 'A')).toEqual([CHECKSUMMED, CHECKSUMMED])
  })

  it('throws on a malformed element', () => {
    expect(() => addressListEnv({ A: `${ADDRESS},nope` }, 'A')).toThrow(
      'A contains an invalid address'
    )
  })
})

describe('resolveLiquidatorAddress', () => {
  it('returns the checksummed LIQUIDATOR_ADDRESS', () => {
    expect(resolveLiquidatorAddress({ LIQUIDATOR_ADDRESS: ADDRESS })).toBe(CHECKSUMMED)
  })

  it('throws when missing', () => {
    expect(() => resolveLiquidatorAddress({})).toThrow(
      'Missing required env var: LIQUIDATOR_ADDRESS'
    )
  })

  it('throws on a malformed value', () => {
    expect(() => resolveLiquidatorAddress({ LIQUIDATOR_ADDRESS: 'nope' })).toThrow(
      'LIQUIDATOR_ADDRESS is not a valid address'
    )
  })
})
