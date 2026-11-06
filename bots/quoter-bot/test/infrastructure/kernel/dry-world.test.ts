import type { Block, TypedPayload } from '@repo/kernel'

import { type Hex, parseSignature } from 'viem'
import { describe, expect, it } from 'vitest'

import { createDryWorld, DRY_SIGNATURE } from '../../../src/infrastructure/kernel/dry-world'

const tree = (root: Hex): TypedPayload => ({
  kind: 'typed',
  domain: { chainId: 8453n },
  types: { OfferTree: [{ name: 'root', type: 'bytes32' }] },
  primaryType: 'OfferTree',
  message: { root }
})

describe('the dry world', () => {
  it('signs typed data with a well-formed signature that no key made, and only while it may act', async () => {
    const { effects } = createDryWorld()
    const guard = (mayAct: boolean) => ({
      signal: new AbortController().signal,
      mayAct: () => mayAct
    })
    const signatures = await Promise.all(
      [tree(`0x${'01'.repeat(32)}`), tree(`0x${'02'.repeat(32)}`)].map(payload =>
        effects.signTyped(payload, guard(true))
      )
    )
    expect(signatures).toStrictEqual([DRY_SIGNATURE, DRY_SIGNATURE])
    expect(parseSignature(DRY_SIGNATURE as Hex)).toStrictEqual({
      r: `0x${'0'.repeat(63)}1`,
      s: `0x${'0'.repeat(63)}1`,
      v: 27n,
      yParity: 0
    })
    await expect(effects.signTyped(tree(`0x${'01'.repeat(32)}`), guard(false))).rejects.toThrow(
      'withdrawn before signing'
    )
  })

  it('follows a real chain: reports its heads, and includes a dry transaction in its next block', async () => {
    const real = (number: number): Block => ({
      number,
      hash: `0x${number.toString(16).padStart(64, 'a')}`,
      parentHash: `0x${(number - 1).toString(16).padStart(64, 'a')}`,
      timestamp: 1_000n + BigInt(number)
    })
    let head = 100
    const { chain, effects } = createDryWorld({
      follow: {
        latest: async () => ({
          head: real(head),
          finalized: { number: head - 10, timestamp: real(head - 10).timestamp }
        }),
        block: async number => real(number),
        safe: async () => real(head - 5)
      }
    })
    const guard = { mayAct: () => true, signal: new AbortController().signal }
    expect((await chain.latest()).head).toEqual(real(100))
    expect(await chain.safe()).toEqual(real(95))

    const payload = {
      kind: 'tx' as const,
      to: `0x${'11'.repeat(20)}`,
      data: '0x' as Hex,
      value: 0n
    }
    const { raw, hash } = (await effects.signTx(
      payload,
      { nonce: 0, level: 0, kind: 'step', fee: 1n, recoveryFee: 1n },
      guard as never
    )) as { raw: string; hash: string }
    expect(await effects.broadcast(raw, guard as never)).toBe('accepted')
    expect(await chain.receipt(hash)).toBeNull()

    head = 101
    await chain.latest()
    expect(await chain.receipt(hash)).toMatchObject({ block: 101, blockHash: real(101).hash })
  })
})
