import { describe, expect, it } from 'vitest'

import type { CursorPage } from '../../src/helpers/collect-pages'

import { collectPages } from '../../src/helpers/collect-pages'

// Serves `pages` in order, recording the cursor it was called with each time. The last page repeats
// once exhausted, so a runaway cursor can be modelled without a bespoke fixture.
const pagedSource = <T>(pages: CursorPage<T>[]) => {
  const seen: (string | null)[] = []
  let index = 0
  return {
    seen,
    fetchPage: async (cursor: string | null) => {
      seen.push(cursor)
      const page = pages[Math.min(index++, pages.length - 1)]
      if (!page) throw new Error('pagedSource was given no pages')
      return page
    }
  }
}

describe('collectPages', () => {
  it('requests the first page with a null cursor and stops when the cursor is null', async () => {
    const source = pagedSource([{ cursor: null, data: ['only'] }])

    const result = await collectPages(source.fetchPage, { maxPages: 10 })

    expect(result).toEqual({ rows: ['only'], pages: 1, truncated: false })
    expect(source.seen).toEqual([null])
  })

  it('follows the cursor and concatenates every page in order', async () => {
    const source = pagedSource([
      { cursor: 'p2', data: ['a', 'b'] },
      { cursor: 'p3', data: ['c'] },
      { cursor: null, data: ['d'] }
    ])

    const result = await collectPages(source.fetchPage, { maxPages: 10 })

    expect(result).toEqual({ rows: ['a', 'b', 'c', 'd'], pages: 3, truncated: false })
    expect(source.seen).toEqual([null, 'p2', 'p3'])
  })

  // A server that never returns a null cursor must not spin forever. `truncated` is the only signal
  // that rows are missing, since a short result is otherwise indistinguishable from a complete one.
  it('stops at maxPages and reports the walk as truncated', async () => {
    const source = pagedSource([{ cursor: 'next', data: ['row'] }])

    const result = await collectPages(source.fetchPage, { maxPages: 3 })

    expect(result).toEqual({ rows: ['row', 'row', 'row'], pages: 3, truncated: true })
  })

  // The cap bounds pages fetched, not pages with a cursor: a walk that ends exactly at the cap with
  // no outstanding cursor read every row there was, and must not be reported as truncated.
  it('is not truncated when the last page lands exactly on the cap', async () => {
    const source = pagedSource([
      { cursor: 'p2', data: ['a'] },
      { cursor: null, data: ['b'] }
    ])

    const result = await collectPages(source.fetchPage, { maxPages: 2 })

    expect(result).toEqual({ rows: ['a', 'b'], pages: 2, truncated: false })
  })

  it('returns an empty result for a single empty page', async () => {
    const result = await collectPages(async () => ({ cursor: null, data: [] }), { maxPages: 10 })

    expect(result).toEqual({ rows: [], pages: 1, truncated: false })
  })
})
