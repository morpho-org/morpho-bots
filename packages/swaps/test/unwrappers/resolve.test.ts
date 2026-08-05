import type { Address } from 'viem'

import { getAddress, isAddressEqual } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Unwrapper } from '../../src/unwrappers/resolve'

import { MAX_UNWRAP_DEPTH, resolveUnwraps } from '../../src/unwrappers/resolve'

const A = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const B = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const C = getAddress('0xcccccccccccccccccccccccccccccccccccccccc')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

// Converts `from` → `to`, halving the amount (distinguishable threading), for any input amount.
function hop(from: Address, to: Address): Unwrapper & { seen: bigint[] } {
  const seen: bigint[] = []
  return {
    kind: `hop:${from.slice(0, 6)}`,
    seen,
    async resolve({ token, amountIn }) {
      if (!isAddressEqual(token, from)) return null
      seen.push(amountIn)
      return {
        step: {
          tokenIn: from,
          tokenOut: to,
          target: from,
          value: 0n,
          callData: '0x12345678',
          amountIn: { source: 'fixed', value: amountIn }
        },
        expectedAmountOut: amountIn,
        amountOutMinimum: amountIn / 2n
      }
    }
  }
}

describe('resolveUnwraps', () => {
  it('returns the input untouched when no unwrapper applies', async () => {
    const resolution = await resolveUnwraps([hop(B, C)], {
      token: A,
      amountIn: 1000n,
      executor: EXECUTOR,
      stopToken: LOAN
    })
    expect(resolution).toEqual({ steps: [], token: A, amountIn: 1000n })
  })

  it('chains hops and threads each amountOutMinimum into the next hop', async () => {
    const first = hop(A, B)
    const second = hop(B, C)
    const resolution = await resolveUnwraps([first, second], {
      token: A,
      amountIn: 1000n,
      executor: EXECUTOR,
      stopToken: LOAN
    })
    expect(resolution.steps.map(step => [step.tokenIn, step.tokenOut])).toEqual([
      [A, B],
      [B, C]
    ])
    expect(resolution.token).toBe(C)
    // 1000 → min 500 threads into the second hop → min 250.
    expect(second.seen).toEqual([500n])
    expect(resolution.amountIn).toBe(250n)
  })

  it('stops at the stopToken without probing further', async () => {
    const toLoan = hop(A, LOAN)
    const beyond = hop(LOAN, C)
    const resolution = await resolveUnwraps([toLoan, beyond], {
      token: A,
      amountIn: 1000n,
      executor: EXECUTOR,
      stopToken: LOAN
    })
    expect(resolution.steps).toHaveLength(1)
    expect(resolution.token).toBe(LOAN)
    expect(beyond.seen).toHaveLength(0)
  })

  it('bounds a non-terminating chain at MAX_UNWRAP_DEPTH', async () => {
    // A → B → A → B → … can never reach the stopToken; the depth bound must cut it off.
    const resolution = await resolveUnwraps([hop(A, B), hop(B, A)], {
      token: A,
      amountIn: 1000n,
      executor: EXECUTOR,
      stopToken: LOAN
    })
    expect(resolution.steps).toHaveLength(MAX_UNWRAP_DEPTH)
  })

  it('treats a self-loop hop (tokenIn === tokenOut) as not applying', async () => {
    const resolution = await resolveUnwraps([hop(A, A)], {
      token: A,
      amountIn: 1000n,
      executor: EXECUTOR,
      stopToken: LOAN
    })
    expect(resolution).toEqual({ steps: [], token: A, amountIn: 1000n })
  })

  it('propagates unwrapper errors to the caller', async () => {
    const broken: Unwrapper = {
      kind: 'broken',
      resolve: async () => {
        throw new Error('probe exploded')
      }
    }
    await expect(
      resolveUnwraps([broken], { token: A, amountIn: 1n, executor: EXECUTOR, stopToken: LOAN })
    ).rejects.toThrow('probe exploded')
  })
})
