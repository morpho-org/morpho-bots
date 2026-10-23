import { describe, expect, it } from 'vitest'

import { intentIdOf, parseIntentId, runIdAt } from '../src'

describe('intent ids', () => {
  it('round-trip the key and run, and reject anything else', () => {
    expect(parseIntentId(intentIdOf('ladder:0xab#c', 'r1', 4))).toEqual({
      key: 'ladder:0xab#c',
      runId: 'r1'
    })
    expect(parseIntentId(intentIdOf('', 'r1', 0, 'act'))).toEqual({
      key: '',
      runId: 'r1',
      task: 'act'
    })
    expect(parseIntentId('ladder:publish:0xroot:1700000000:3')).toBeUndefined()
  })

  it('never repeat across two runs started on one clock reading', () => {
    const at = 1_700_000_000_000
    const [first, second] = [runIdAt(at), runIdAt(at)]

    expect(intentIdOf('market:0xab', first, 0, 'publish')).not.toBe(
      intentIdOf('market:0xab', second, 0, 'publish')
    )
    expect(parseIntentId(intentIdOf('market:0xab', first, 0, 'publish'))).toEqual({
      key: 'market:0xab',
      runId: first,
      task: 'publish'
    })
  })
})
