import { describe, expect, test } from 'bun:test'
import { getAbiItem, toFunctionSelector } from 'viem'

import { ExecutorAbi } from '../../src/v2/ExecutorAbi'

// The Executor's entry-point names are vanity-mined for near-zero selectors (cheaper dispatch);
// the bot's encoder and the executooor-viem helpers both key off these exact selectors, so pin
// them. The full solc-output parity check lives in bots/midnight-liquidation
// test/contracts/executor.sol.test.ts (solc is a dependency there, not here).
const EXECUTOR_SELECTORS = [
  ['exec_606BaXt', '0x00000001'],
  ['call_g0oyU7o', '0x00000000']
] as const

describe('ExecutorAbi', () => {
  test.each(EXECUTOR_SELECTORS)('%s has its mined selector %s', (name, selector) => {
    expect(toFunctionSelector(getAbiItem({ abi: ExecutorAbi, name }))).toBe(selector)
  })

  test('has no constructor — the owner gate (and its ctor arg) is stripped in the vendored copy', () => {
    expect(
      (ExecutorAbi as readonly { type: string }[]).some(entry => entry.type === 'constructor')
    ).toBe(false)
  })

  test('keeps the payable fallback that services callback-driven protocols (e.g. Midnight onLiquidate)', () => {
    expect(ExecutorAbi.find(entry => entry.type === 'fallback')).toEqual({
      stateMutability: 'payable',
      type: 'fallback'
    })
    expect(ExecutorAbi.find(entry => entry.type === 'receive')).toEqual({
      stateMutability: 'payable',
      type: 'receive'
    })
  })
})
