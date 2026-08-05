import { describe, expect, it } from 'vitest'

import { tryOrUndefined } from '../../src/helpers/tryOrUndefined'

describe('tryOrUndefined', () => {
  it('should return value when function succeeds', () => {
    const result = tryOrUndefined(() => 42)

    expect(result).toBe(42)
  })

  it('should return undefined when function throws', () => {
    const result = tryOrUndefined(() => {
      throw new Error('test error')
    })

    expect(result).toBeUndefined()
  })

  it('should handle different return types', () => {
    expect(tryOrUndefined(() => 'string')).toBe('string')
    expect(tryOrUndefined(() => [1, 2, 3])).toEqual([1, 2, 3])
    expect(tryOrUndefined(() => ({ key: 'value' }))).toEqual({ key: 'value' })
    expect(tryOrUndefined(() => true)).toBe(true)
    expect(tryOrUndefined(() => null)).toBeNull()
  })

  it('should return undefined for any type of thrown error', () => {
    expect(
      tryOrUndefined(() => {
        throw new Error('error')
      })
    ).toBeUndefined()
    expect(
      tryOrUndefined(() => {
        throw 'string error'
      })
    ).toBeUndefined()
    expect(
      tryOrUndefined(() => {
        throw { code: 500 }
      })
    ).toBeUndefined()
    expect(
      tryOrUndefined(() => {
        throw null
      })
    ).toBeUndefined()
    expect(
      tryOrUndefined(() => {
        throw undefined
      })
    ).toBeUndefined()
  })

  it('should handle JSON.parse failures', () => {
    const result = tryOrUndefined(() => JSON.parse('invalid json'))

    expect(result).toBeUndefined()
  })

  it('should handle property access on null/undefined', () => {
    const obj = null as any
    const result = tryOrUndefined(() => obj.property.nested)

    expect(result).toBeUndefined()
  })

  it('should allow returning undefined explicitly', () => {
    const result = tryOrUndefined(() => undefined)

    expect(result).toBeUndefined()
  })
})
