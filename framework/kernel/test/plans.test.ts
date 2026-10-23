import { describe, expect, it } from 'vitest'

import type { KernelEvent, PlanInput } from '../src'

import { argsOf, fnOf } from './codec'
import {
  ecrecoverPlan,
  FEE,
  liquidationPlan,
  offer,
  publish,
  setterPlan,
  transfer,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
const twoTransfers: PlanInput = {
  intentId: 'x',
  steps: [
    { kind: 'tx', payload: transfer(10n, 'a') },
    { kind: 'tx', payload: transfer(10n, 'b') }
  ],
  notAfter: 1_000_000,
  basisBlock: 0
}

const withLiveOffer = () => {
  const h = new Harness().start().liveOffer()
  expect(h.entry(G1)?.state).toBe('live')
  return h
}

describe('plans', () => {
  it('a liquidation is simulated, flushed, broadcast, and settled on inclusion; its fee reserve ends on resolution', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.simulate()
    h.sign()
    const flushIndex = h.log.findIndex(c => c.type === 'flush' && c.seq === 2)
    expect(flushIndex).toBeGreaterThan(-1)
    expect(h.commands('broadcast')).toHaveLength(0)
    h.flush()
    expect(h.commands('broadcast')).toHaveLength(1)
    expect(h.available('native')).toBe(99n * FEE)
    h.broadcast()
    h.head()
    h.mine(h.candidate('0xexec').hash)
    expect(h.notices('liq:K1')).toEqual(['admitted', 'settled'])
    expect(h.available('native')).toBe(100n * FEE)
    h.finalize(h.block)
    expect(h.state.nonces).toEqual({})
    expect(h.available('native')).toBe(100n * FEE)
  })

  it('ecrecover quoting signs in memory, exposes at the publish commit, and goes live on inclusion', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 100n), offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', t) })
    expect(h.entry(G1)?.state).toBe('intended')
    expect(h.available(W.loan)).toBe(700n)
    h.sign()
    expect(h.entry(G1)?.state).toBe('signed')
    expect(h.disk).not.toContain(G1)
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.simulate()
    h.sign()
    expect(h.entry(G1)?.state).toBe('exposed')
    h.flush()
    expect(h.disk).toContain(G1)
    h.broadcast()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.notices('q:M1')).toEqual(['admitted', 'settled'])
    expect(h.available(W.loan)).toBe(700n)
  })

  it('a dependent step is materialized from the witness it was submitted with, and only that', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 100n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', t) })
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M2', tree(offer('g2', 100n))) })
    h.sign()
    const [first, second] = h.commands('materialize')
    expect(first).toMatchObject({ intentId: 'q:M1', step: 1, witness: t })
    expect(second?.witness).not.toEqual(t)

    const bare = new Harness().start()
    const plan = ecrecoverPlan('q:M3', t)
    bare.send({
      type: 'Submit',
      plan: { ...plan, steps: [plan.steps[0]!, { kind: 'tx' }] }
    })
    bare.sign()
    expect(bare.commands('materialize')).toHaveLength(1)
    expect(bare.commands('materialize')[0]).not.toHaveProperty('witness')
  })

  it('a setter plan waits for a basis re-read at or after the ratification before it publishes', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 100n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q:M1', t) })
    h.drive()
    h.head(5)
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.state.plans['q:M1']?.phase).toBe('awaiting-advance')
    expect(h.pending('simulate')).toHaveLength(0)
    h.advance('q:M1', { basisBlock: 4 })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'stalled',
      reason: 'decision predates our own inclusion'
    })
    expect(h.pending('simulate')).toHaveLength(0)
    h.advance('q:M1', { basisBlock: 5 })
    expect(h.pending('simulate')).toHaveLength(1)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.notices('q:M1')).toEqual(['admitted', 'stalled', 'advanced', 'settled'])
  })

  it('a stage advanced with no deadline drops the one the first stage was submitted with', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 100n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: { ...setterPlan('q:M1', t), notAfter: h.now + 1_000 } })
    h.drive()
    h.head(5)
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q:M1', { basisBlock: 5 })
    h.tick(2_000)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.notices('q:M1')).toEqual(['admitted', 'advanced', 'settled'])
  })

  it('an advance that does not state its stage and basis leaves the plan parked', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 100n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q:M1', t) })
    h.drive()
    h.head(5)
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.send({ type: 'Advance', intentId: 'q:M1' } as KernelEvent)
    h.send({ type: 'Advance', intentId: 'q:M1', stage: 1 } as KernelEvent)
    expect(h.notices('q:M1')).toEqual(['admitted', 'stalled', 'stalled'])
    expect(h.state.plans['q:M1']?.phase).toBe('awaiting-advance')
    expect(h.pending('simulate').map(c => fnOf(c.payload))).not.toContain('publish')
  })

  it('a settled notice names every included step, even one whose nonce record was pruned at finality', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 100n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q:M1', t) })
    h.drive()
    h.head(5)
    const ratification = h.candidate('0xsetIsRootRatified').hash
    h.mine(ratification)
    const ratifiedAt = h.block
    h.finalize(h.block)
    expect(Object.values(h.state.nonces).map(record => record.resolution?.winner)).not.toContain(
      ratification
    )
    h.advance('q:M1')
    h.drive()
    h.head()
    const publication = h.candidate('0xpublish').hash
    h.mine(publication)
    const settled = h.commands('notify').find(c => c.intentId === 'q:M1' && c.notice === 'settled')
    expect(settled?.included).toStrictEqual([
      { step: 0, hash: ratification, block: ratifiedAt },
      { step: 1, hash: publication, block: h.block }
    ])
  })

  it('a plan that ends on a reverted step still names its transaction', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive()
    h.head()
    const reverted = h.candidate('0xexec').hash
    h.mine(reverted, { status: 'reverted' })
    const minedAt = h.block
    h.finalize(h.block)
    const ended = h
      .commands('notify')
      .filter(c => c.intentId === 'liq')
      .at(-1)
    expect(ended?.included).toStrictEqual([{ step: 0, hash: reverted, block: minedAt }])
  })

  it('a fill observed at finality shrinks the reservation to what remains, and a full fill retires it', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.observe(G1, 120n)
    h.finalize(h.block)
    expect(h.available(W.loan)).toBe(820n)
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.entry(G1)?.retiredBy).toBe('filled')
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('a commitment past its enforceable expiry at a final block retires without any action', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { expiry: 20n }))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.finalize(10)
    expect(h.entry(G1)?.state).toBe('live')
    h.finalize(11)
    expect(h.entry(G1)?.retiredBy).toBe('expired')
  })

  it('keeps no reference to a submitted plan, so changing it afterwards changes nothing sent', () => {
    const h = new Harness().start()
    const payload = transfer(10n)
    const plan: PlanInput = {
      intentId: 'x',
      steps: [{ kind: 'tx', payload }],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    ;(payload as { data: string }).data = transfer(900n).data
    h.drive()
    const [sent] = h.candidates()
    expect(argsOf(sent?.payload).amount).toBe(10n)
    expect(h.available(W.loan)).toBe(990n)
  })

  it('an intent id named by an unretired entry is refused as a duplicate after its plan settles', () => {
    const h = withLiveOffer()
    expect(h.state.plans['q:M1']?.status).toBe('settled')
    h.send({ type: 'Submit', plan: liquidationPlan('q:M1') })
    expect(h.notices('q:M1')).toEqual(['admitted', 'settled', 'refused'])
    expect(h.refusal('q:M1')).toEqual({
      code: 'duplicate',
      reason: 'duplicate: unresolved exposure'
    })
    h.drive()
    expect(h.commands('broadcast').filter(c => c.hash.startsWith('0xexec:'))).toHaveLength(0)
    expect(h.state.plans['q:M1']?.status).toBe('settled')
  })

  it('a later step simulated at a block before the previous inclusion is re-simulated before signing', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: twoTransfers })
    h.drive()
    h.head()
    h.head()
    h.mine(h.candidate('0xtransfer:a').hash)
    h.advance('x')
    const [stepTwo] = h.pending('simulate').slice(-1)
    const before = h.block - 1
    h.send({
      type: 'Simulated',
      request: stepTwo!.request,
      ok: true,
      block: before,
      blockHash: h.hash(before)
    })
    expect(h.commands('sign')).toHaveLength(1)
    expect(h.commands('simulate')).toHaveLength(3)
    h.drive()
    expect(h.broadcastsTo('transfer')).toHaveLength(2)
    h.head()
    h.mine(h.candidate('0xtransfer:b').hash)
    expect(h.notices('x')).toEqual(['admitted', 'advanced', 'settled'])
  })

  it('a simulation result answering a broadcast request is discarded, so the step is never sent again', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    h.flush()
    const [inFlight] = h.pending('broadcast')
    h.send({
      type: 'Simulated',
      request: inFlight!.request,
      ok: true,
      block: h.block,
      blockHash: h.hash(h.block)
    })
    expect(h.state.slot).toBe(inFlight!.request)
    h.drive()
    expect(h.broadcastsTo('exec')).toHaveLength(1)
    expect(h.candidates()).toHaveLength(1)
    h.head()
    h.mine(h.candidate('0xexec').hash)
    expect(h.notices('liq')).toEqual(['admitted', 'settled'])
  })
})
