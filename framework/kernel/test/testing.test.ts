import { describe, expect, it } from 'vitest'

import type { TxPayload } from '../src'

import { FakeChain, MemoryStore } from '../src/testing'

const payload: TxPayload = { kind: 'tx', to: '0x1', data: '0x', value: 0n }
const guard = { signal: AbortSignal.timeout(1_000), mayAct: () => true }

describe('the scenario fake chain', () => {
  it('mines broadcast transactions in nonce order and reports what onMined decides', async () => {
    const chain = new FakeChain()
    chain.onMined = (_payload, block) => (block === 2 ? 'reverted' : 'success')
    const first = await chain.effects.signTx(payload, { nonce: 0, level: 0, fee: 0n }, guard)
    const second = await chain.effects.signTx(payload, { nonce: 1, level: 0, fee: 0n }, guard)
    expect(await chain.effects.broadcast(second.raw, guard)).toBe('accepted')
    expect(await chain.effects.broadcast(first.raw, guard)).toBe('accepted')
    expect(await chain.nonceAt()).toEqual({ latest: 0, pending: 2 })

    chain.mine(false)
    expect(await chain.receipt(first.hash)).toBeNull()

    chain.mine()
    expect(await chain.receipt(first.hash)).toMatchObject({ block: 3, status: 'success' })
    expect(await chain.nonceTx(1)).toMatchObject({ hash: second.hash, status: 'success' })
    expect(await chain.nonceAt()).toEqual({ latest: 2, pending: 2 })
    expect((await chain.latest()).finalized.number).toBe(2)
  })

  it('holds signing until released and refuses a withdrawn signature', async () => {
    const chain = new FakeChain()
    const held = chain.holdSigning()
    let signed = false
    const signing = chain.effects
      .signTx(payload, { nonce: 0, level: 0, fee: 0n }, guard)
      .then(() => (signed = true))
    await Promise.resolve()
    expect(signed).toBe(false)
    held.open()
    await signing
    expect(chain.signed).toHaveLength(1)
    await expect(
      chain.effects.signTx(
        payload,
        { nonce: 1, level: 0, fee: 0n },
        { ...guard, mayAct: () => false }
      )
    ).rejects.toThrow('withdrawn before signing')
  })
})

describe('the scenario memory store', () => {
  it('round-trips a ledger and counts writes', async () => {
    const store = new MemoryStore()
    expect(await store.read()).toBeNull()
    const ledger = { version: 1, entries: [] } as never
    await store.write(ledger)
    expect(store.writes).toBe(1)
    expect(await store.read()).toEqual(ledger)
  })
})
