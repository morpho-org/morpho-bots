import { describe, expect, it } from 'vitest'

import { fnOf } from './codec'
import {
  cancel,
  ecrecoverPlan,
  liquidationPlan,
  makeConfig,
  offer,
  publish,
  T,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
const live = () => {
  const h = new Harness().start()
  h.finalizedLag = 5
  h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  h.head()
  h.mine(h.candidate('0xpublish').hash)
  h.finalize(h.block)
  return h
}

describe('finality and reorgs', () => {
  it('a reorg that removes a cancel reopens it; the reservation was never released', () => {
    const h = live()
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'revoke:g1',
        steps: [{ kind: 'tx', payload: cancel() }],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.drive()
    h.head()
    const minedAt = h.block
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(h.entry(G1)).toMatchObject({ state: 'revoking', retireEvidence: { block: minedAt } })
    expect(h.available(W.loan)).toBe(700n)
    h.reorg(minedAt - 1)
    h.head()
    expect(h.entry(G1)?.state).toBe('revoking')
    expect(h.entry(G1)?.retireEvidence).toBeUndefined()
    expect(Object.values(h.state.nonces)[0]?.resolution).toBeUndefined()
    expect(h.available(W.loan)).toBe(700n)
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('a provisional fill makes nothing available; a reorg of it is harmless; the final fill releases', () => {
    const h = live()
    h.head()
    h.observe(G1, 200n)
    expect(h.available(W.loan)).toBe(700n)
    h.reorg(h.block - 1)
    h.head()
    expect(h.entry(G1)?.observed).toBeUndefined()
    expect(h.entry(G1)?.consumedFinal).toBe(0n)
    h.observe(G1, 120n)
    h.finalize(h.block)
    expect(h.entry(G1)?.consumedFinal).toBe(120n)
    expect(h.available(W.loan)).toBe(820n)
  })

  it('a reorg below the finalized block is a finality violation and moves the kernel to recovery', () => {
    const h = live()
    h.reorg(h.state.finalized.number - 1)
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'finality violated' })
  })

  it('a reorg never erases the record of an exposure made in response to a rolled-back frame', () => {
    const h = new Harness().start()
    h.finalizedLag = 5
    for (let i = 0; i < 3; i++) h.head()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    const minedAt = h.block
    h.mine(h.candidate('0xpublish').hash)
    expect(h.entry(G1)?.state).toBe('live')
    h.reorg(minedAt - 1)
    h.head()
    expect(h.entry(G1)?.state).toBe('exposed')
    expect(Object.values(h.state.nonces)[0]?.resolution).toBeUndefined()
    expect(h.candidate('0xpublish').sent).toBe('accepted')
    expect(h.available(W.loan)).toBe(700n)
    expect(h.disk).toContain(G1)
  })

  it('capacity read at a block that is reorged away cannot back an admission', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.head()
    h.capacity(W.loan, 1000n, 2)
    h.reorg(1)
    h.head()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', tree(offer('g1', 900n))) })
    expect(h.notices('q')).toEqual(['refused'])
    expect(h.state.capacity[W.loan]).toBeUndefined()
  })

  it('a capacity read that arrives late from an orphaned block is ignored', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.head()
    const orphaned = h.hash(2)
    h.reorg(1)
    h.head()
    h.send({ type: 'Capacity', resource: W.loan, amount: 1000n, block: 2, blockHash: orphaned })
    expect(h.state.capacity[W.loan]).toBeUndefined()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', tree(offer('g1', 900n))) })
    expect(h.notices('q')).toEqual(['refused'])
  })

  it('dispatch withholds an act whose simulation block the kernel knows was orphaned', () => {
    const h = new Harness().start()
    h.head()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    expect(h.state.plans.liq?.sim).toMatchObject({ block: 2, blockHash: 'b2' })
    h.sign()
    h.reorg(1)
    h.head()
    expect(h.hash(2)).not.toBe('b2')
    h.flush()
    expect(h.broadcastsTo('exec')).toHaveLength(0)
    expect(h.candidate('0xexec').sent).toBe('withheld')
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'compensating',
      reason: 'withheld: simulation orphaned by a reorg'
    })
    h.drive()
    const fill = h.candidate('0xfill')
    h.head()
    h.mine(fill.hash)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
    h.finalize(h.block)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating', 'compensated'])
  })

  it('a simulation orphaned while the signer runs is redone, and nothing is committed on it', () => {
    const h = new Harness().start()
    h.head()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.reorg(1)
    h.head()
    h.sign()
    expect(h.candidates()).toEqual([])
    expect(h.commands('flush')).toHaveLength(1)
    expect(h.pending('simulate')).toHaveLength(1)
    h.drive()
    expect(h.broadcastsTo('exec')).toHaveLength(1)
    h.head()
    h.mine(h.candidate('0xexec').hash)
    expect(h.notices('liq')).toEqual(['admitted', 'settled'])
  })

  it('an entry whose neutralizer is reorged into a revert after its last allowed attempt is stuck, not retried', () => {
    const h = new Harness(makeConfig({ maxRecoveryAttempts: 1 })).start()
    h.finalizedLag = 5
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.finalize(h.block)
    h.send({ type: 'Stop' })
    h.drive()
    h.head()
    const minedAt = h.block
    const cancel = h.candidate('0xsetConsumed').hash
    h.mine(cancel)
    expect(h.entry(G1)).toMatchObject({ state: 'revoking', retireEvidence: { block: minedAt } })
    h.reorg(minedAt - 1)
    h.head()
    h.mine(cancel, { status: 'reverted' })
    expect(h.entry(G1)).toMatchObject({ state: 'live', stuck: true })
    h.drive()
    expect(
      h.commands('sign').filter(c => c.payload.kind === 'tx' && fnOf(c.payload) === 'setConsumed')
    ).toHaveLength(1)
  })
})
