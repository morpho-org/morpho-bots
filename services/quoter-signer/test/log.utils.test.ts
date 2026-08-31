import { afterEach, describe, expect, it, vi } from 'vitest'

import { emitJsonLine } from '../src/log.utils'

describe('emitJsonLine', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes one JSON line with bigints serialized as decimal strings', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })

    emitJsonLine({ event: 'middleware.intent_received', amount: 123n })

    expect(lines).toStrictEqual(['{"event":"middleware.intent_received","amount":"123"}'])
  })
})
