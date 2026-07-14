import { describe, expect, it } from 'bun:test'
import { keccak256, stringToBytes } from 'viem'

import { CALLBACK_SUCCESS } from '../src/constants'

describe('protocol constants', () => {
  it('CALLBACK_SUCCESS is keccak256("morpho.midnight.callbackSuccess")', () => {
    expect(CALLBACK_SUCCESS).toBe(keccak256(stringToBytes('morpho.midnight.callbackSuccess')))
  })
})
