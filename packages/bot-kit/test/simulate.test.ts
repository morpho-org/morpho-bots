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
    transport: custom({
      request: async ({ method, params }) => {
        if (method === 'eth_chainId') return `0x${base.id.toString(16)}`
        if (method === 'eth_call') {
          calls.push((params as Record<string, unknown>[])[0] ?? {})
          return onCall()
        }
        throw new Error(`unexpected RPC method ${method}`)
      }
    })
  })
}

describe('simulateCall', () => {
  it('returns ok when the call succeeds', async () => {
    const client = clientThatCalls(() => '0x')
    expect(await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })).toEqual({
      status: 'ok'
    })
  })

  it('returns revert with a reason when the call reverts', async () => {
    const client = clientThatCalls(() => {
      throw new Error('execution reverted: InconsistentReallocation')
    })
    const result = await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })
    expect(result.status).toBe('revert')
    expect(result.reason).toBeTruthy()
  })

  it('sends the from/to/data of the would-be broadcast', async () => {
    const calls: Record<string, unknown>[] = []
    const client = clientThatCalls(() => '0x', calls)
    await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })
    expect(calls[0]).toMatchObject({
      from: EOA.toLowerCase(),
      to: EXECUTOR.toLowerCase(),
      data: DATA
    })
  })

  it('threads the tx value and defaults it to zero', async () => {
    const calls: Record<string, unknown>[] = []
    const client = clientThatCalls(() => '0x', calls)
    await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA, value: 7n })
    await simulateCall(client, { eoa: EOA, to: EXECUTOR, data: DATA })
    expect(calls[0]?.value).toBe('0x7')
    expect(calls[1]?.value).toBe('0x0')
  })
})

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

  it('threads the tx value into the eth_call so the sim matches the broadcast byte-for-byte', async () => {
    const calls: Record<string, unknown>[] = []
    const client = clientThatCalls(() => '0x', calls)
    await simulateLiquidationExec(client, {
      executooor: EXECUTOR,
      eoa: EOA,
      data: DATA,
      value: 5n
    })
    expect(calls[0]?.value).toBe('0x5') // viem hex-encodes the value word
  })

  it('defaults value to zero when omitted', async () => {
    const calls: Record<string, unknown>[] = []
    const client = clientThatCalls(() => '0x', calls)
    await simulateLiquidationExec(client, { executooor: EXECUTOR, eoa: EOA, data: DATA })
    expect(calls[0]?.value).toBe('0x0')
  })
})
