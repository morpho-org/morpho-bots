import { keccak256, stringToBytes } from 'viem'
import { describe, expect, it } from 'vitest'

import { CALLBACK_SUCCESS, LISTED_MARKETS_MAX_AGE_MS } from '../src/constants'

describe('protocol constants', () => {
  it('CALLBACK_SUCCESS is keccak256("morpho.midnight.callbackSuccess")', () => {
    expect(CALLBACK_SUCCESS).toBe(keccak256(stringToBytes('morpho.midnight.callbackSuccess')))
  })

  it('stops authorizing a listing ten minutes after its last fresh read', () => {
    expect(LISTED_MARKETS_MAX_AGE_MS).toBe(600_000)
  })
})
