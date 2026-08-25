import { describe, expect, it } from 'vitest'

import { INTENT_KINDS, classifyIntentKind } from '../src/intent.utils'

describe('classifyIntentKind', () => {
  it.each(INTENT_KINDS)('recognizes the %s intent kind', kind => {
    expect(classifyIntentKind({ kind })).toBe(kind)
  })

  it.each([
    undefined,
    null,
    'quote',
    { kind: 'QUOTE' },
    { kind: 'drain-the-eoa' },
    { kind: 7 },
    { type: 'quote' }
  ])('collapses %j to unknown so no caller-controlled string is ever logged', event => {
    expect(classifyIntentKind(event)).toBe('unknown')
  })
})
