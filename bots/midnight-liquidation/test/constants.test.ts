import { describe, expect, it } from 'bun:test'
import { keccak256, parseEther, stringToBytes } from 'viem'

import { CALLBACK_SUCCESS, ORACLE_PRICE_SCALE, TIME_TO_MAX_LIF, WAD } from '../src/constants'

describe('protocol constants', () => {
  it('CALLBACK_SUCCESS is keccak256("morpho.midnight.callbackSuccess")', () => {
    expect(CALLBACK_SUCCESS).toBe(keccak256(stringToBytes('morpho.midnight.callbackSuccess')))
  })

  it('WAD is one ether (1e18)', () => {
    expect(WAD).toBe(parseEther('1'))
  })

  it('ORACLE_PRICE_SCALE is WAD squared (1e36)', () => {
    expect(ORACLE_PRICE_SCALE).toBe(WAD * WAD)
  })

  it('TIME_TO_MAX_LIF is 60 minutes expressed in seconds', () => {
    expect(TIME_TO_MAX_LIF).toBe(60n * 60n)
  })
})
