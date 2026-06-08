import { describe, expect, it } from 'bun:test'

import type { Page } from '../../src/api/pagination'

import { paginate } from '../../src/api/pagination'

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const row of gen) out.push(row)
  return out
}

describe('paginate', () => {
  it('walks pages until the cursor is null', async () => {
    const pages: Record<string, Page<number>> = {
      undefined: { cursor: 'c1', data: [1, 2] },
      c1: { cursor: 'c2', data: [3] },
      c2: { cursor: null, data: [4, 5] }
    }
    const seen: (string | undefined)[] = []
    const rows = await collect(
      paginate<number>(async cursor => {
        seen.push(cursor)
        return pages[String(cursor)] ?? { cursor: null, data: [] }
      })
    )
    expect(rows).toEqual([1, 2, 3, 4, 5])
    expect(seen).toEqual([undefined, 'c1', 'c2'])
  })

  it('throws when the page cap is exceeded', async () => {
    const gen = paginate<number>(async () => ({ cursor: 'never-null', data: [1] }))
    await expect(collect(gen)).rejects.toThrow(/exceeded \d+ pages/)
  })

  it('propagates a fetchPage error', async () => {
    const gen = paginate<number>(async () => {
      throw new Error('boom')
    })
    await expect(collect(gen)).rejects.toThrow('boom')
  })
})
