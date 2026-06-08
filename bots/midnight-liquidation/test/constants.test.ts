import { describe, expect, it } from 'bun:test'
import { keccak256, parseEther, stringToBytes } from 'viem'

import {
  CALLBACK_SUCCESS,
  MAX_COLLATERALS_PER_BORROWER,
  ORACLE_PRICE_SCALE,
  TIME_TO_MAX_LIF,
  WAD
} from '../src/constants'

describe('protocol constants', () => {
  it('CALLBACK_SUCCESS is keccak256("MIDNIGHT CALLBACK SUCCESS")', () => {
    expect(CALLBACK_SUCCESS).toBe(keccak256(stringToBytes('MIDNIGHT CALLBACK SUCCESS')))
  })

  it('WAD is one ether (1e18)', () => {
    expect(WAD).toBe(parseEther('1'))
  })

  it('ORACLE_PRICE_SCALE is WAD squared (1e36)', () => {
    expect(ORACLE_PRICE_SCALE).toBe(WAD * WAD)
  })

  it('TIME_TO_MAX_LIF is 15 minutes expressed in seconds', () => {
    expect(TIME_TO_MAX_LIF).toBe(15n * 60n)
  })

  it('MAX_COLLATERALS_PER_BORROWER matches the Midnight constant', () => {
    expect(MAX_COLLATERALS_PER_BORROWER).toBe(16)
  })
})
