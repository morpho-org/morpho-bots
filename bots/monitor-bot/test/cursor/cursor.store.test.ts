import { describe, expect, it } from 'vitest'

import { InMemoryCursorStore } from '../../src/cursor/cursor.store'

describe('InMemoryCursorStore', () => {
  it('returns null for an unknown id', async () => {
    const store = new InMemoryCursorStore()
    expect(await store.get('missing')).toBeNull()
  })

  it('round-trips a cursor value', async () => {
    const store = new InMemoryCursorStore()
    await store.set('a', { lastCreatedAt: 123, seenIds: ['x'] })
    expect(await store.get('a')).toEqual({ lastCreatedAt: 123, seenIds: ['x'] })
  })

  it('isolates cursors per id and overwrites on set', async () => {
    const store = new InMemoryCursorStore()
    await store.set('a', 1)
    await store.set('b', 2)
    await store.set('a', 3)
    expect(await store.get('a')).toBe(3)
    expect(await store.get('b')).toBe(2)
  })
})
