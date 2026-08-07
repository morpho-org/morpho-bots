import { describe, expect, it, vi } from 'vitest'

import { retryUntilDefined } from '../../src/helpers/retry'

describe('retryUntilDefined', () => {
  it('should return value immediately if defined on first try', async () => {
    const fn = vi.fn(() => 'success')

    const result = await retryUntilDefined(fn)

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should retry until value is defined', async () => {
    const fn = vi
      .fn<() => string | undefined>(() => undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue('success')

    const result = await retryUntilDefined(fn, { retryDelay: 1 })

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should throw error after max retries', async () => {
    const fn = vi.fn<() => string | undefined>(() => undefined)

    await expect(retryUntilDefined(fn, { maxRetries: 3, retryDelay: 1 })).rejects.toThrow(
      'Value not defined after 3 retries'
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should call onRetry callback with attempt number', async () => {
    const fn = vi
      .fn<() => string | undefined>(() => undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue('success')
    const onRetry = vi.fn(() => {})

    await retryUntilDefined(fn, { retryDelay: 1, onRetry })

    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1)
    expect(onRetry).toHaveBeenNthCalledWith(2, 2)
  })

  it('should handle different return types', async () => {
    const fnNumber = vi.fn(() => 42)
    const fnBoolean = vi.fn(() => false)
    const fnObject = vi.fn(() => ({ foo: 'bar' }))
    const fnArray = vi.fn(() => [1, 2, 3])

    const [num, bool, obj, arr] = await Promise.all([
      retryUntilDefined(fnNumber),
      retryUntilDefined(fnBoolean),
      retryUntilDefined(fnObject),
      retryUntilDefined(fnArray)
    ])

    expect(num).toBe(42)
    expect(bool).toBe(false)
    expect(obj).toEqual({ foo: 'bar' })
    expect(arr).toEqual([1, 2, 3])
  })

  it('should treat null as defined value', async () => {
    const fn = vi.fn(() => null)

    const result = await retryUntilDefined(fn)

    expect(result).toBe(null)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should not call onRetry on last failed attempt', async () => {
    const fn = vi.fn<() => string | undefined>(() => undefined)
    const onRetry = vi.fn(() => {})

    await expect(retryUntilDefined(fn, { maxRetries: 3, retryDelay: 1, onRetry })).rejects.toThrow()
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).not.toHaveBeenCalledWith(3)
  })

  it('should handle functions that throw errors', async () => {
    const fn = vi.fn<() => string | undefined>(() => {
      throw new Error('First error')
    })

    await expect(retryUntilDefined(fn)).rejects.toThrow('First error')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should handle zero as a defined value', async () => {
    const fn = vi.fn(() => 0)

    const result = await retryUntilDefined(fn)

    expect(result).toBe(0)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should handle empty string as a defined value', async () => {
    const fn = vi.fn(() => '')

    const result = await retryUntilDefined(fn)

    expect(result).toBe('')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
