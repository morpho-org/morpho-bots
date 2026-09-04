import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { SafeProviderFailure } from '../../../src/application/setup/safe-provider.error'

import { SafeProviderError } from '../../../src/application/setup/safe-provider.error'
import { ProviderReadError } from '../../../src/infrastructure/setup-state/provider-read.error'
import { retryTransientProviderRead } from '../../../src/infrastructure/setup-state/provider-retry.utils'

const providerError = (failure: Omit<SafeProviderFailure, 'kind' | 'provider'>) =>
  new SafeProviderError({ kind: 'provider-error', provider: 'router-api', ...failure })

const settle = async <Result>(pending: Promise<Result>) => {
  const outcome = pending.then(
    value => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.advanceTimersByTimeAsync(60_000)
  return outcome
}

describe('retryTransientProviderRead', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test.each([
    ['a 5xx response', providerError({ name: 'HttpError', status: 503, context: 'request' })],
    ['a 429 response', providerError({ name: 'HttpError', status: 429, context: 'request' })],
    ['a 408 response', providerError({ name: 'HttpError', status: 408, context: 'request' })],
    [
      'a request timeout',
      providerError({ name: 'TimeoutError', code: 'REQUEST_TIMEOUT', context: 'request' })
    ],
    ['a network fault', providerError({ name: 'NetworkError', context: 'request' })]
  ])('retries after %s and returns the eventual success', async (_label, error) => {
    const attempt = vi.fn<() => Promise<string>>()
    attempt.mockRejectedValueOnce(error).mockResolvedValueOnce('recovered')

    await expect(settle(retryTransientProviderRead(attempt))).resolves.toEqual({
      value: 'recovered'
    })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  test('retries a sanitized RPC timeout and returns the eventual success', async () => {
    const error = new ProviderReadError('rpc', 'chain-id', {
      name: 'TimeoutError',
      code: 'ETIMEDOUT'
    })
    const attempt = vi.fn<() => Promise<string>>()
    attempt.mockRejectedValueOnce(error).mockResolvedValueOnce('recovered')

    await expect(settle(retryTransientProviderRead(attempt))).resolves.toEqual({
      value: 'recovered'
    })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['400', 400],
    ['404', 404],
    ['403', 403]
  ])('does not retry an HTTP %s response', async (_label, status) => {
    const error = providerError({ name: 'HttpError', status, context: 'request' })
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error)

    await expect(settle(retryTransientProviderRead(attempt))).resolves.toEqual({ error })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  test('does not retry a failure that is not a sanitized provider failure', async () => {
    const error = new TypeError('unexpected')
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error)

    await expect(settle(retryTransientProviderRead(attempt))).resolves.toEqual({ error })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  test('exhausts three attempts and rethrows the final sanitized provider error', async () => {
    const error = providerError({ name: 'HttpError', status: 502, context: 'request' })
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error)

    const outcome = await settle(retryTransientProviderRead(attempt))

    expect(attempt).toHaveBeenCalledTimes(3)
    expect(outcome).toEqual({ error })
    expect(error).toBeInstanceOf(SafeProviderError)
    expect(error.failure).toStrictEqual({
      kind: 'provider-error',
      provider: 'router-api',
      name: 'HttpError',
      status: 502,
      context: 'request'
    })
  })

  test('waits a half-jittered exponential backoff between attempts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const error = providerError({ name: 'NetworkError', context: 'request' })
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    const pending = retryTransientProviderRead(attempt).catch(() => 'failed')

    await vi.advanceTimersByTimeAsync(249)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(499)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(3)
    await expect(pending).resolves.toBe('failed')
  })

  test('limits attempts and backoff to one aggregate timeout', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const error = providerError({ name: 'NetworkError', context: 'request' })
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error)

    await expect(settle(retryTransientProviderRead(attempt, 300))).resolves.toEqual({ error })

    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt.mock.calls).toEqual([[300], [50]])
  })

  test('does not back off after a failed attempt consumes the aggregate timeout', async () => {
    const error = providerError({ name: 'NetworkError', context: 'request' })
    const attempt = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      throw error
    })

    await expect(settle(retryTransientProviderRead(attempt, 300))).resolves.toEqual({ error })

    expect(attempt).toHaveBeenCalledTimes(1)
  })

  test('keeps each jittered backoff between half and the full exponential delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999)
    const error = providerError({ name: 'NetworkError', context: 'request' })
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    const pending = retryTransientProviderRead(attempt).catch(() => 'failed')

    await vi.advanceTimersByTimeAsync(249)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(251)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(499)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(501)
    expect(attempt).toHaveBeenCalledTimes(3)
    await expect(pending).resolves.toBe('failed')
  })
})
