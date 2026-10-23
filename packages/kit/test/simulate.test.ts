import type { Hex } from 'viem'

import { createPublicClient, custom, getAddress } from 'viem'
import { base } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { simulateCall, simulateLiquidationExec } from '../src/simulate'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const EOA = getAddress('0x4444444444444444444444444444444444444444')
const DATA: Hex = '0xdeadbeef'

// A client whose `eth_call` is driven by `onCall`: returning a hex string models a successful exec,
// throwing models a revert somewhere in the seize → swap → repay → sweep path. Captured `eth_call`
// param objects are pushed to `calls` so tests can assert the exact request that would be broadcast.
function clientThatCalls(onCall: () => string, calls: Record<string, unknown>[] = []) {
  return createPublicClient({
    chain: base,
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method === 'eth_chainId') return `0x${base.id.toString(16)}`
          if (method === 'eth_call') {
            calls.push((params as Record<string, unknown>[])[0] ?? {})
            return onCall()
          }
          throw new Error(`unexpected RPC method ${method}`)
        }
      },
      { retryCount: 0 }
    )
  })
}

const reverting = (message: string) =>
  clientThatCalls(() => {
    throw new Error(message)
  })

describe('simulateCall', () => {
  it('returns ok when the call succeeds', async () => {
    const client = clientThatCalls(() => '0x')
    expect(await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })).toEqual({
      status: 'ok'
    })
  })

  it('reports a revert with the short message as its reason', async () => {
    const client = reverting('execution reverted: InconsistentReallocation')
    expect(await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })).toStrictEqual({
      status: 'revert',
      reason: 'Execution reverted with reason: InconsistentReallocation.'
    })
  })

  it('sends the from/to/data of the would-be broadcast, with its value or zero', async () => {
    const calls: Record<string, unknown>[] = []
    const client = clientThatCalls(() => '0x', calls)
    await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA, value: 7n })
    await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })
    expect(calls).toMatchObject([
      { from: EOA.toLowerCase(), to: EXECUTOR.toLowerCase(), data: DATA, value: '0x7' },
      { from: EOA.toLowerCase(), to: EXECUTOR.toLowerCase(), data: DATA, value: '0x0' }
    ])
  })
})

describe('simulateLiquidationExec', () => {
  it('returns ok when the exec_606BaXt call succeeds', async () => {
    const client = clientThatCalls(() => '0x')
    expect(
      await simulateLiquidationExec(client, { executooor: EXECUTOR, eoa: EOA, data: DATA })
    ).toEqual({ status: 'ok' })
  })

  it('reports a revert of the exec call with the short message as its reason', async () => {
    const client = reverting('execution reverted: NotLiquidatable')
    expect(
      await simulateLiquidationExec(client, { executooor: EXECUTOR, eoa: EOA, data: DATA })
    ).toStrictEqual({
      status: 'revert',
      reason: 'Execution reverted with reason: NotLiquidatable.'
    })
  })

  it('calls the Executor from the EOA with the exact calldata and value it would broadcast', async () => {
    const calls: Record<string, unknown>[] = []
    const client = clientThatCalls(() => '0x', calls)
    await simulateLiquidationExec(client, { executooor: EXECUTOR, eoa: EOA, data: DATA, value: 5n })
    await simulateLiquidationExec(client, { executooor: EXECUTOR, eoa: EOA, data: DATA })
    expect(calls).toMatchObject([
      { from: EOA.toLowerCase(), to: EXECUTOR.toLowerCase(), data: DATA, value: '0x5' },
      { from: EOA.toLowerCase(), to: EXECUTOR.toLowerCase(), data: DATA, value: '0x0' }
    ])
  })
})
