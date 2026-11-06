import type { KernelHead } from '@repo/kernel'

import { describe, expect, it, vi } from 'vitest'

import { runReadonly } from '../src/readonly'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

describe('runReadonly', () => {
  it('scans at each latest block until stopped, carrying on past a failed block read', async () => {
    const stopping = new AbortController()
    let height = 0
    const latest = vi.fn(async (): Promise<KernelHead> => {
      height += 1
      if (height === 2) throw new Error('the node is down')
      return { number: height, hash: `0x${height.toString(16)}` }
    })
    const scanned: number[] = []
    const scan = vi.fn(async (at: KernelHead) => {
      scanned.push(at.number)
      if (scanned.length === 3) stopping.abort()
    })

    await runReadonly({ latest, scan, everyMs: 1, signal: stopping.signal, logger: silent })

    expect(scanned).toStrictEqual([1, 3, 4])
  })

  it('stops while waiting for the next scan, without scanning again', async () => {
    const stopping = new AbortController()
    const scan = vi.fn(async () => {
      setTimeout(() => stopping.abort(), 5)
    })

    await runReadonly({
      latest: async () => ({ number: 1, hash: '0x1' }),
      scan,
      everyMs: 60_000,
      signal: stopping.signal,
      logger: silent
    })

    expect(scan).toHaveBeenCalledOnce()
  })
})
