import { describe, expect, test } from 'bun:test'
import { encodeErrorResult } from 'viem'

import { MidnightAbi } from '../../src/v2/MidnightAbi'

// The sizing/eligibility revert selectors the midnight-liquidation simulate classifier keys off to
// distinguish a rejected plan ("revert") from an unfunded-but-valid plan ("unfunded"). Pinning them
// here guards the classifier against an ABI regeneration that renames or drops one of these errors.
// (All five are zero-arg, so encodeErrorResult returns just the 4-byte selector.)
const MIDNIGHT_REVERT_SELECTORS = [
  ['NotLiquidatable', '0xddeb79ba'],
  ['RecoveryCloseFactorConditionsViolated', '0x1b428e88'],
  ['InconsistentInput', '0xf0732dd7'],
  ['NotBorrower', '0xcb1e8f38'],
  ['LiquidatorGatedFromLiquidating', '0x37a4840b']
] as const

describe('MidnightAbi', () => {
  test.each(MIDNIGHT_REVERT_SELECTORS)(
    'error %s resolves to selector %s',
    (errorName, selector) => {
      expect(encodeErrorResult({ abi: MidnightAbi, errorName })).toBe(selector)
    }
  )

  test('liquidate is the 9-arg main signature', () => {
    const liquidate = MidnightAbi.find(
      entry => entry.type === 'function' && entry.name === 'liquidate'
    )
    expect(liquidate && 'inputs' in liquidate ? liquidate.inputs.map(i => i.name) : []).toEqual([
      'market',
      'collateralIndex',
      'seizedAssets',
      'repaidUnits',
      'borrower',
      'postMaturityMode',
      'receiver',
      'callback',
      'data'
    ])
  })
})
