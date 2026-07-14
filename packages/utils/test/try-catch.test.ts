import { describe, expect, it } from 'bun:test'

import { tryCatch } from '../src/try-catch'

describe('tryCatch', () => {
  describe('synchronous function form', () => {
    it('should return success result with data when function returns', () => {
      const result = tryCatch(() => 42)

      expect(result).toEqual({ data: 42, error: null })
    })

    it('should return failure result with error when function throws', () => {
      const error = new Error('test error')
      const result = tryCatch(() => {
        throw error
      })

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toBe('test error')
    })

    it('should handle non-Error throws and convert to Error', () => {
      const result = tryCatch(() => {
        throw 'string error'
      })

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toContain('This value was thrown as is')
    })

    it('should handle object throws', () => {
      const result = tryCatch(() => {
        throw { code: 500, message: 'Server error' }
      })

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
    })

    it('should handle null and undefined throws', () => {
      const nullResult = tryCatch(() => {
        throw null
      })
      const undefinedResult = tryCatch(() => {
        throw undefined
      })

      expect(nullResult.data).toBeNull()
      expect(nullResult.error).toBeInstanceOf(Error)
      expect(undefinedResult.data).toBeNull()
      expect(undefinedResult.error).toBeInstanceOf(Error)
    })

    it('should preserve error properties', () => {
      const error = new Error('test')
      error.cause = 'root cause'
      const result = tryCatch(() => {
        throw error
      })

      expect(result.error?.cause).toBe('root cause')
    })

    it('should work with different return types', () => {
      const stringResult = tryCatch(() => 'hello')
      const arrayResult = tryCatch(() => [1, 2, 3])
      const objectResult = tryCatch(() => ({ key: 'value' }))
      const nullResult = tryCatch(() => null)

      expect(stringResult.data).toBe('hello')
      expect(arrayResult.data).toEqual([1, 2, 3])
      expect(objectResult.data).toEqual({ key: 'value' })
      expect(nullResult.data).toBeNull()
    })
  })

  // The promise overload shares the same formatError → ensureError normalization as the sync form,
  // so it only needs to prove the `.then` (success) / `.catch` (normalize) wiring. The full
  // normalization matrix lives in the sync form above and in errors.test.ts.
  describe('promise form', () => {
    it('should return success result with data when promise resolves', async () => {
      const result = await tryCatch(Promise.resolve(42))

      expect(result).toEqual({ data: 42, error: null })
    })

    it('should handle non-Error rejections and convert to Error', async () => {
      const result = await tryCatch(Promise.reject('string error'))

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toContain('This value was thrown as is')
    })

    it('should preserve error properties', async () => {
      const error = new Error('test')
      error.cause = 'root cause'
      const result = await tryCatch(Promise.reject(error))

      expect(result.error?.cause).toBe('root cause')
    })
  })

  describe('custom error types', () => {
    class CustomError extends Error {
      code: number
      constructor(message: string, code: number) {
        super(message)
        this.code = code
      }
    }

    it('should preserve custom error type in sync form', () => {
      const result = tryCatch<never, CustomError>(() => {
        throw new CustomError('custom', 42)
      })

      expect(result.error).toBeInstanceOf(CustomError)
      expect((result.error as CustomError).code).toBe(42)
    })

    it('should preserve custom error type in async form', async () => {
      const result = await tryCatch<never, CustomError>(
        Promise.reject(new CustomError('async', 99))
      )

      expect(result.error).toBeInstanceOf(CustomError)
      expect((result.error as CustomError).code).toBe(99)
    })
  })
})
