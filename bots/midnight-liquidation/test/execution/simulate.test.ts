import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { createPublicClient, custom, getAddress } from 'viem'
import { base } from 'viem/chains'

import { simulateLiquidationExec } from '../../src/execution/simulate'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const EOA = getAddress('0x4444444444444444444444444444444444444444')
const DATA: Hex = '0xdeadbeef'

// A client whose `eth_call` is driven by `onCall`: returning a hex string models a successful exec,
// throwing models a revert somewhere in the seize → swap → repay → sweep path.
function clientThatCalls(onCall: () => string) {
  return createPublicClient({
    chain: base,
    transport: custom({
      request: async ({ method }) => {
        if (method === 'eth_chainId') return `0x${base.id.toString(16)}`
        if (method === 'eth_call') return onCall()
        throw new Error(`unexpected RPC method ${method}`)
      }
    })
  })
}

describe('simulateLiquidationExec', () => {
  it('returns ok when the exec_606BaXt call succeeds', async () => {
    const client = clientThatCalls(() => '0x')
    expect(
      await simulateLiquidationExec(client, { executooor: EXECUTOR, eoa: EOA, data: DATA })
    ).toEqual({ status: 'ok' })
  })

  it('returns revert with a reason when the exec call reverts', async () => {
    const client = clientThatCalls(() => {
      throw new Error('execution reverted: NotLiquidatable')
    })
    const result = await simulateLiquidationExec(client, {
      executooor: EXECUTOR,
      eoa: EOA,
      data: DATA
    })
    expect(result.status).toBe('revert')
    expect(result.reason).toBeTruthy()
  })
})
