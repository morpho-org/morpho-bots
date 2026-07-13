import { describe, expect, it } from 'bun:test'

import { assertNever, ensureError } from '../src/errors'

describe('ensureError', () => {
  it('should return the same Error if already an Error instance', () => {
    const error = new Error('test error')

    const result = ensureError(error)

    expect(result).toBe(error)
    expect(result.message).toBe('test error')
  })

  it('should convert string to Error', () => {
    const result = ensureError('string error')

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('This value was thrown as is, not through an Error')
    expect(result.message).toContain('"string error"')
  })

  it('should convert number to Error', () => {
    const result = ensureError(42)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('This value was thrown as is, not through an Error')
    expect(result.message).toContain('42')
  })

  it('should convert object to Error', () => {
    const obj = { code: 500, message: 'Server error' }
    const result = ensureError(obj)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('This value was thrown as is, not through an Error')
    expect(result.message).toContain('{"code":500,"message":"Server error"}')
  })

  it('should convert null to Error', () => {
    const result = ensureError(null)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('This value was thrown as is, not through an Error')
    expect(result.message).toContain('null')
  })

  it('should convert undefined to Error', () => {
    const result = ensureError(undefined)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('This value was thrown as is, not through an Error')
  })

  it('should convert boolean to Error', () => {
    const result = ensureError(false)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('false')
  })

  it('should have shortMessage property', () => {
    const result = ensureError('test')

    expect(result.shortMessage).toBe('"test"')
  })

  it('should preserve Error shortMessage if already present', () => {
    const error = new Error('test error') as Error & { shortMessage?: string }
    error.shortMessage = 'short message'

    const result = ensureError(error)

    expect(result.shortMessage).toBe('short message')
  })

  it('should handle objects that cannot be stringified', () => {
    const circular: any = { a: 1 }
    circular.self = circular

    const result = ensureError(circular)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('[Unable to stringify thrown value]')
    expect(result.shortMessage).toBe('[Unable to stringify thrown value]')
  })

  it('should handle arrays', () => {
    const result = ensureError([1, 2, 3])

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('[1,2,3]')
  })

  it('should handle BigInt values', () => {
    const result = ensureError({ value: 'test' })

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('{"value":"test"}')
  })
})

describe('assertNever', () => {
  it('should throw error with unhandled case message', () => {
    const value = 'unexpected' as never

    expect(() => assertNever(value)).toThrow('Unhandled case: "unexpected"')
  })

  it('should include the value in error message', () => {
    const value = 123 as never

    expect(() => assertNever(value)).toThrow('Unhandled case: 123')
  })

  it('should handle object values', () => {
    const value = { type: 'unknown' } as never

    expect(() => assertNever(value)).toThrow('Unhandled case: {"type":"unknown"}')
  })

  it('should be used in exhaustiveness checks', () => {
    type Status = 'success' | 'error'

    function handleStatus(status: Status) {
      switch (status) {
        case 'success':
          return 'OK'
        case 'error':
          return 'FAIL'
        default:
          return assertNever(status)
      }
    }

    expect(handleStatus('success')).toBe('OK')
    expect(handleStatus('error')).toBe('FAIL')
  })
})
