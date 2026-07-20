import { describe, expect, it } from 'vitest'

import type { Alert } from '../../src/alerts/alert'

import { InMemoryCursorStore } from '../../src/cursor/cursor.store'
import { Poller, type PollerDependencies } from '../../src/polling/poller'
import { capturingDispatcher, fakeLogger } from '../helpers'

type FetchResult = { items: string[]; nextState: number }

// Sample implementation of the generic poller: cursor is a number, items are strings, one alert
// per item unless toAlerts is overridden.
class SamplePoller extends Poller<number, string> {
  readonly id = 'sample'
  readonly cron = '*/5 * * * * *'
  readonly seenCursors: (number | null)[] = []

  constructor(
    deps: PollerDependencies,
    private readonly impl: {
      fetch: (cursor: number | null) => Promise<FetchResult>
      toAlerts?: (items: string[]) => Alert[]
    }
  ) {
    super(deps)
  }

  protected fetch(cursor: number | null) {
    this.seenCursors.push(cursor)
    return this.impl.fetch(cursor)
  }

  protected toAlerts(items: string[]) {
    if (this.impl.toAlerts) return this.impl.toAlerts(items)
    return items.map(item => ({
      key: item,
      title: item,
      lines: [],
      severity: 'info' as const
    }))
  }
}

function makeDeps() {
  const cursors = new InMemoryCursorStore()
  const dispatcher = capturingDispatcher()
  return { cursors, dispatcher, deps: { state: cursors, dispatcher, logger: fakeLogger() } }
}

describe('Poller.pollOnce', () => {
  it('passes null on the first tick and the saved cursor on the next', async () => {
    const { deps } = makeDeps()
    const poller = new SamplePoller(deps, {
      fetch: cursor => Promise.resolve({ items: [], nextState: (cursor ?? 0) + 1 })
    })
    await poller.pollOnce()
    await poller.pollOnce()
    expect(poller.seenCursors).toEqual([null, 1])
  })

  it('advances the cursor after a successful dispatch', async () => {
    const { cursors, dispatcher, deps } = makeDeps()
    const poller = new SamplePoller(deps, {
      fetch: () => Promise.resolve({ items: ['a', 'b'], nextState: 7 })
    })
    await poller.pollOnce()
    expect(await cursors.get('sample')).toBe(7)
    expect(dispatcher.sent).toEqual([
      [
        { key: 'a', title: 'a', lines: [], severity: 'info' },
        { key: 'b', title: 'b', lines: [], severity: 'info' }
      ]
    ])
  })

  it('does not advance the cursor when fetch fails', async () => {
    const { cursors, dispatcher, deps } = makeDeps()
    const poller = new SamplePoller(deps, {
      fetch: () => Promise.reject(new Error('endpoint down'))
    })
    await expect(poller.pollOnce()).rejects.toThrow('endpoint down')
    expect(await cursors.get('sample')).toBeNull()
    expect(dispatcher.sent).toEqual([])
  })

  it('does not advance the cursor when dispatch fails, then retries the same window', async () => {
    const { cursors, dispatcher, deps } = makeDeps()
    const poller = new SamplePoller(deps, {
      fetch: () => Promise.resolve({ items: ['a'], nextState: 3 })
    })
    dispatcher.failNext()
    await expect(poller.pollOnce()).rejects.toThrow('dispatch failed')
    expect(await cursors.get('sample')).toBeNull()

    // The next tick re-fetches the same (null) window and succeeds — at-least-once delivery.
    await poller.pollOnce()
    expect(poller.seenCursors).toEqual([null, null])
    expect(await cursors.get('sample')).toBe(3)
    expect(dispatcher.sent).toHaveLength(1)
  })

  it('does not advance the cursor when toAlerts fails', async () => {
    const { cursors, dispatcher, deps } = makeDeps()
    const poller = new SamplePoller(deps, {
      fetch: () => Promise.resolve({ items: ['a'], nextState: 9 }),
      toAlerts: () => {
        throw new Error('mapping failed')
      }
    })
    await expect(poller.pollOnce()).rejects.toThrow('mapping failed')
    expect(await cursors.get('sample')).toBeNull()
    expect(dispatcher.sent).toEqual([])
  })

  it('skips dispatch entirely for an empty alert list but still advances the cursor', async () => {
    const { cursors, dispatcher, deps } = makeDeps()
    const poller = new SamplePoller(deps, {
      fetch: () => Promise.resolve({ items: ['ignored'], nextState: 5 }),
      toAlerts: () => []
    })
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
    expect(await cursors.get('sample')).toBe(5)
  })
})
