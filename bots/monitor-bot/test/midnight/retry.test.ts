import { describe, expect, it, vi } from 'vitest'

import { fetchMidnightWithRetry, MidnightRateLimitError } from '../../src/midnight/retry'

describe('fetchMidnightWithRetry', () => {
  it('fails a rate-limited request immediately without sleeping or retrying', async () => {
    const request = vi.fn(() => Promise.reject(new MidnightRateLimitError(601_000)))
    const sleep = vi.fn(() => Promise.resolve())

    await expect(
      fetchMidnightWithRetry(request, { label: 'markets.discover', sleep })
    ).rejects.toThrow('markets.discover rate limited until 1970-01-01T00:10:01.000Z')
    expect(request).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('still retries transient network failures', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({
        data: { data: [] },
        response: new Response(null, { status: 200 })
      })
    const sleep = vi.fn(() => Promise.resolve())

    await expect(
      fetchMidnightWithRetry(request, { label: 'markets.discover', sleep })
    ).resolves.toEqual({ data: [] })
    expect(request).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(200)
  })
})
