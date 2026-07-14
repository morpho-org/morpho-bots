import { describe, expect, it } from 'bun:test'

import { assertNever, ensureError } from '../src/errors'

describe('ensureError', () => {
  it('should return the same Error if already an Error instance', () => {
    const error = new Error('test error')

    const result = ensureError(error)

    expect(result).toBe(error)
    expect(result.message).toBe('test error')
  })

  it.each([
    ['string', 'string error', '"string error"'],
    ['number', 42, '42'],
    ['object', { code: 500, message: 'Server error' }, '{"code":500,"message":"Server error"}'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['boolean', false, 'false'],
    ['array', [1, 2, 3], '[1,2,3]']
  ] as const)(
    'wraps a thrown %s as an Error carrying the stringified value',
    (_label, input, fragment) => {
      const result = ensureError(input)

      expect(result).toBeInstanceOf(Error)
      expect(result.message).toContain('This value was thrown as is, not through an Error')
      expect(result.message).toContain(fragment)
    }
  )

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
