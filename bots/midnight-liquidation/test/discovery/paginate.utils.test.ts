import type { LogLevel, Logger } from '@repo/bot-kit'

import { describe, expect, it } from 'vitest'

import type { CursorPage } from '../../src/discovery/paginate.utils'

import { collectPages } from '../../src/discovery/paginate.utils'

// A capturing logger so the backstop's operator-visible event is assertable by name, level, and fields.
const capturingLogger = () => {
  const events: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = []
  const record = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields: fields ?? {} })
  }
  return {
    find: (event: string) => events.find(entry => entry.event === event),
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error')
    } satisfies Logger
  }
}

// Serves `pages` in order, recording the cursor it was called with each time.
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

const deps = (logger: Logger) => ({ logger, maxPages: 10, event: 'test.max_pages' })

describe('collectPages', () => {
  it('requests the first page with a null cursor and stops when the cursor is null', async () => {
    const source = pagedSource([{ cursor: null, data: ['only'] }])
    const logs = capturingLogger()

    const rows = await collectPages(source.fetchPage, deps(logs.logger))

    expect(rows).toEqual(['only'])
    expect(source.seen).toEqual([null])
    expect(logs.find('test.max_pages')).toBeUndefined()
  })

  it('follows the cursor and concatenates every page in order', async () => {
    const source = pagedSource([
      { cursor: 'p2', data: ['a', 'b'] },
      { cursor: 'p3', data: ['c'] },
      { cursor: null, data: ['d'] }
    ])

    const rows = await collectPages(source.fetchPage, deps(capturingLogger().logger))

    expect(rows).toEqual(['a', 'b', 'c', 'd'])
    expect(source.seen).toEqual([null, 'p2', 'p3'])
  })

  // A server that never returns a null cursor must not spin forever. Truncation here is silent
  // under-inclusion, so the stop is reported at warn under the caller's own event name.
  it('stops at maxPages and warns under the caller-supplied event name', async () => {
    const logs = capturingLogger()
    const runaway = async () => ({ cursor: 'next', data: ['row'] })

    const rows = await collectPages(runaway, {
      logger: logs.logger,
      maxPages: 3,
      event: 'walk.capped'
    })

    expect(rows).toEqual(['row', 'row', 'row'])
    const capped = logs.find('walk.capped')
    expect(capped?.level).toBe('warn')
    expect(capped?.fields).toEqual({ pages: 3, cap: 3, rows: 3 })
  })

  it('returns an empty result for a single empty page without warning', async () => {
    const logs = capturingLogger()

    const rows = await collectPages(async () => ({ cursor: null, data: [] }), deps(logs.logger))

    expect(rows).toEqual([])
    expect(logs.find('test.max_pages')).toBeUndefined()
  })
})
