import { describe, expect, it } from 'bun:test'

import { splitIdPrefix } from '../src/records'

describe('splitIdPrefix', () => {
  it('splits the generic <domain>:<op> prefix off a full id', () => {
    expect(splitIdPrefix('blue:unhealthy-positions:8453:0xa:0xb')).toEqual({
      domain: 'blue',
      op: 'unhealthy-positions'
    })
  })

  it('reads domain + op from a bare two-segment prefix', () => {
    expect(splitIdPrefix('midnight:liquidate')).toEqual({ domain: 'midnight', op: 'liquidate' })
  })

  it('falls back to unknown for the op when the label has a single segment', () => {
    expect(splitIdPrefix('label-with-no-colon')).toEqual({
      domain: 'label-with-no-colon',
      op: 'unknown'
    })
  })

  it('falls back to unknown for both parts of an empty label', () => {
    expect(splitIdPrefix('')).toEqual({ domain: 'unknown', op: 'unknown' })
  })
})
