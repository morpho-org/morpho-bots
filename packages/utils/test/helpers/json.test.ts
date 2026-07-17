import { describe, expect, it } from 'bun:test'
import { Address } from 'viem'

import { bigintReplacer, bigIntReviver, parse, stringify } from '../../src/helpers/json'

const MARKET1: Address = '0x1eda1b67414336cab3914316cb58339ddaef9e43f939af1fed162a989c98bc20'
const MARKET2: Address = '0x2eda1b67414336cab3914316cb58339ddaef9e43f939af1fed162a989c98bc21'
const BORROWER1: Address = '0x1111111111111111111111111111111111111111'
const BORROWER2: Address = '0x2222222222222222222222222222222222222222'
const BORROWER3: Address = '0x3333333333333333333333333333333333333333'

describe('storage.ts', () => {
  it('should serialize a MarketToBorrowerMap with bigint values correctly', () => {
    const map = {
      [MARKET1]: {
        [BORROWER1]: { borrow: 100n, collateral: 200n },
        [BORROWER2]: { borrow: 300n, collateral: 400n }
      },
      [MARKET2]: {
        [BORROWER3]: { borrow: 500n, collateral: 600n }
      }
    }

    const serialized = JSON.stringify(map, bigintReplacer)
    expect(serialized).toBe(
      JSON.stringify({
        [MARKET1]: {
          [BORROWER1]: { borrow: { __bigint__: '100' }, collateral: { __bigint__: '200' } },
          [BORROWER2]: { borrow: { __bigint__: '300' }, collateral: { __bigint__: '400' } }
        },
        [MARKET2]: {
          [BORROWER3]: { borrow: { __bigint__: '500' }, collateral: { __bigint__: '600' } }
        }
      })
    )
  })

  it('should deserialize a serialized MarketToBorrowerMap with bigint values correctly', () => {
    const serialized = JSON.stringify({
      [MARKET1]: {
        [BORROWER1]: { borrow: { __bigint__: '100' }, collateral: { __bigint__: '200' } },
        [BORROWER2]: { borrow: { __bigint__: '300' }, collateral: { __bigint__: '400' } }
      },
      [MARKET2]: {
        [BORROWER3]: { borrow: { __bigint__: '500' }, collateral: { __bigint__: '600' } }
      }
    })

    const deserialized = JSON.parse(serialized, bigIntReviver)
    expect(deserialized).toEqual({
      [MARKET1]: {
        [BORROWER1]: { borrow: 100n, collateral: 200n },
        [BORROWER2]: { borrow: 300n, collateral: 400n }
      },
      [MARKET2]: {
        [BORROWER3]: { borrow: 500n, collateral: 600n }
      }
    })
  })

  it('should handle empty MarketToBorrowerMap correctly', () => {
    const map = {}

    const serialized = JSON.stringify(map, bigintReplacer)
    expect(serialized).toBe('{}')

    const deserialized = JSON.parse(serialized, bigIntReviver)
    expect(deserialized).toEqual({})
  })

  it('should handle invalid serialized data gracefully', () => {
    const invalidSerialized = '{"invalid": "data"}'

    expect(() => JSON.parse(invalidSerialized, bigIntReviver)).not.toThrow()
    const deserialized = JSON.parse(invalidSerialized, bigIntReviver)
    expect(deserialized).toEqual({ invalid: 'data' })
  })
})

describe('bigintReplacer', () => {
  it('should convert bigint to __bigint__ object', () => {
    const result = bigintReplacer('key', 100n)

    expect(result).toEqual({ __bigint__: '100' })
  })

  it('should not modify non-bigint values', () => {
    expect(bigintReplacer('key', 'string')).toBe('string')
    expect(bigintReplacer('key', 123)).toBe(123)
    expect(bigintReplacer('key', null)).toBeNull()
    expect(bigintReplacer('key', { a: 1 })).toEqual({ a: 1 })
  })
})

describe('bigIntReviver', () => {
  it('should convert __bigint__ object to bigint', () => {
    const result = bigIntReviver('key', { __bigint__: '100' })

    expect(result).toBe(100n)
  })

  it('should not modify non-__bigint__ objects', () => {
    expect(bigIntReviver('key', { a: 1 })).toEqual({ a: 1 })
    expect(bigIntReviver('key', 'string')).toBe('string')
    expect(bigIntReviver('key', 123)).toBe(123)
  })

  it('should handle null values', () => {
    expect(bigIntReviver('key', null)).toBeNull()
  })

  it('should handle arrays', () => {
    expect(bigIntReviver('key', [1, 2, 3])).toEqual([1, 2, 3])
  })
})

describe('stringify', () => {
  it('should stringify objects with bigint support', () => {
    const obj = { id: 1, amount: 100n }
    const result = stringify(obj)

    expect(result).toBe('{"id":1,"amount":{"__bigint__":"100"}}')
  })

  it('should handle nested bigints', () => {
    const obj = { data: { value: 200n } }
    const result = stringify(obj)

    expect(result).toContain('__bigint__')
  })

  it('should handle arrays with bigints', () => {
    const arr = [1n, 2n, 3n]
    const result = stringify(arr)

    expect(result).toBe('[{"__bigint__":"1"},{"__bigint__":"2"},{"__bigint__":"3"}]')
  })
})

describe('parse', () => {
  it('should parse JSON strings with bigint support', () => {
    const json = '{"id":1,"amount":{"__bigint__":"100"}}'
    const result = parse<{ id: number; amount: bigint }>(json)

    expect(result).toEqual({ id: 1, amount: 100n })
  })

  it('should return undefined for invalid JSON when errorHandling is not "throw"', () => {
    const result = parse('invalid json')

    expect(result).toBeUndefined()
  })

  it('should throw error for invalid JSON when errorHandling is "throw"', () => {
    expect(() => parse('invalid json', 'throw')).toThrow()
  })

  it('should parse valid JSON when errorHandling is "throw"', () => {
    const result = parse<{ id: number }>('{"id":1}', 'throw')

    expect(result).toEqual({ id: 1 })
  })

  it('should handle arrays', () => {
    const json = '[1,2,3]'
    const result = parse<number[]>(json)

    expect(result).toEqual([1, 2, 3])
  })

  it('should handle null', () => {
    const result = parse('null')

    expect(result).toBeNull()
  })

  it('should handle primitives', () => {
    expect(parse<string>('"test"')).toBe('test')
    expect(parse<number>('42')).toBe(42)
    expect(parse<boolean>('true')).toBe(true)
  })
})
