import { describe, expect, it } from 'vitest'

import type { DurableLedger } from '../src'

import { decodeLedger } from '../src'
import { FEE, liquidationPlan } from './fixtures'
import { Harness } from './harness'

const signCommands = (h: Harness) => h.commands('sign').flatMap(c => ('nonce' in c ? [c] : []))

describe('signed bids', () => {
  it('records the bid a candidate was signed at, and its first broadcast as its send head', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    expect(h.candidate('0xexec')).toMatchObject({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 1n,
      sendHead: 1
    })
    h.head()
    h.flush()
    h.broadcast('unknown')
    expect(h.candidate('0xexec').sendHead).toBe(2)
    for (let i = 0; i < 2 * h.config.stuckBlocks; i++) h.head()
    expect(h.commands('broadcast').length).toBeGreaterThan(1)
    expect(h.candidate('0xexec').sendHead).toBe(2)
  })

  it('keeps the commit head as the send head of bytes a crash kept from leaving', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    h.head()
    h.flush({ ack: false })
    const [record] = Object.values(h.ledger()!.nonces)
    expect(record!.candidates[0]!.sendHead).toBe(1)
  })

  it('asks a replacement to outbid the highest fees recorded at its nonce', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive('rejected')
    h.drive()
    const [first, fill] = signCommands(h)
    expect(first).toMatchObject({ kind: 'step', nonce: 0 })
    expect(first!.outbid).toBeUndefined()
    expect(fill).toMatchObject({
      kind: 'fill',
      nonce: 0,
      outbid: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
    })
    expect(h.candidate('0xfill')).toMatchObject({ maxFeePerGas: 2n, maxPriorityFeePerGas: 2n })
  })

  it('asks for the highest recorded fees field by field over every candidate at the nonce, across a restart', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    const signAt = (maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) => {
      h.simulate()
      const command = h.pending('sign').at(-1)
      if (!command || !('nonce' in command)) throw new Error('no transaction to sign')
      const hash = `0x${command.kind}:${command.feeLevel}`
      h.send({
        type: 'Signed',
        request: command.request,
        hash,
        raw: `raw(${hash})`,
        bid: { maxFeePerGas, maxPriorityFeePerGas, gas: 1n }
      })
      h.flush()
      h.broadcast('rejected')
      h.flush()
    }
    signAt(100n, 1n)
    signAt(90n, 50n)
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0)
    h.simulate()
    const [third] = signCommands(h)
    expect(third).toMatchObject({
      kind: 'fill',
      nonce: 0,
      outbid: { maxFeePerGas: 100n, maxPriorityFeePerGas: 50n }
    })
  })

  it('leaves a step its signer cannot price under the step cap waiting, unsigned, until its deadline', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    const [capped] = h.pending('sign')
    h.send({ type: 'StepCapReached', request: capped!.request })
    expect(h.state.slot).toBeUndefined()
    expect(h.state.plans.liq).toMatchObject({ status: 'executing', phase: 'sign' })
    expect(h.notices('liq')).toEqual(['admitted'])
    h.head()
    expect(signCommands(h)).toHaveLength(1)

    h.send({ type: 'Submit', plan: liquidationPlan('next') })
    h.simulate()
    h.sign()
    expect(h.candidate('0xexec:next')).toMatchObject({ nonce: 0, kind: 'step' })

    h.tick(1_000_000)
    expect(h.notices('liq')).toEqual(['admitted', 'abandoned'])
    expect(h.candidates().filter(c => c.intentId === 'liq')).toEqual([])
  })

  it('leaves a fill its signer cannot price under the fee ceiling waiting, unsigned and unfailed, at its nonce', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    h.flush()
    h.broadcast('rejected')
    h.simulate()
    const [capped] = h.pending('sign')
    expect(capped).toMatchObject({ kind: 'fill', nonce: 0 })
    h.send({ type: 'FeeCeilingReached', request: capped!.request })
    expect(h.state.slot).toBeUndefined()
    expect(h.candidates().map(c => c.kind)).toEqual(['step'])
    expect(h.state.nonces[0]?.failedFillHead).toBeUndefined()
    expect(Object.values(h.state.plans).find(p => p.recovery)).toMatchObject({
      status: 'executing',
      phase: 'include',
      terms: { nonce: 0, capped: true }
    })
  })

  it('fails a neutralizer at a fresh nonce its signer cannot price under the fee ceiling as a recovery attempt', () => {
    const h = new Harness().start().liveOffer()
    h.finalize(h.block)
    h.send({ type: 'Stop' })
    h.simulate()
    const [capped] = h.pending('sign')
    expect(capped).toMatchObject({ kind: 'neutralizer' })
    h.send({ type: 'FeeCeilingReached', request: capped!.request })
    expect(h.state.plans[capped!.intentId]).toBeUndefined()
    expect(Object.values(h.state.entries).map(e => e.recoveryAttempts)).toEqual([2])
  })

  it('refuses a ledger whose candidate records a malformed bid', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('q') })
    h.simulate()
    h.sign()
    h.flush()
    const stored = decodeLedger(h.disk!)
    const withBid = (fields: Record<string, unknown>): DurableLedger => {
      const ledger = structuredClone(stored)
      Object.assign(Object.values(ledger.nonces)[0]!.candidates[0]!, fields)
      return ledger
    }
    for (const fields of [
      { maxFeePerGas: undefined },
      { gas: -1n },
      { gas: 0n },
      { gas: FEE + 1n },
      { maxPriorityFeePerGas: 2n, maxFeePerGas: 1n },
      { sendHead: -1 },
      { sendHead: undefined }
    ]) {
      h.crash()
      h.boot('enrolled', withBid(fields))
      expect(h.commands('report').at(-1)?.reason).toBe(
        'malformed ledger: candidate 0.0 has a malformed signed bid'
      )
    }
  })
})
