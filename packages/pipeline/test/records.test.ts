import { describe, expect, it } from 'bun:test'

import { rawRecordId } from '../src/records'

describe('rawRecordId', () => {
  it('returns a non-empty string id', () => {
    expect(rawRecordId({ id: 'blue:liquidate:8453:0xabc:0xdef' })).toBe(
      'blue:liquidate:8453:0xabc:0xdef'
    )
  })

  it('ignores extra fields and still extracts the id', () => {
    expect(rawRecordId({ kind: 'position', id: 'x', junk: 1 })).toBe('x')
  })

  it.each([
    ['a missing id', { kind: 'position' }],
    ['an empty id', { id: '' }],
    ['a whitespace-only id', { id: '   ' }],
    ['a non-string id', { id: 42 }],
    ['null', null],
    ['a non-object', 'just-a-string'],
    ['an array', ['id', 'x']]
  ])('returns undefined for %s', (_label, value) => {
    expect(rawRecordId(value)).toBeUndefined()
  })
})
