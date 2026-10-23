import { describe, expect, it } from 'vitest'

import type { PlanInput } from '../src'

import { latched, querySubmission } from '../src'
import { encodeCall } from './codec'
import { ecrecoverPlan, liquidationPlan, offer, publish, signTree, T, tree, W } from './fixtures'
import { Harness } from './harness'
import { midnightId, treeRoot } from './validators'

const G1 = midnightId('g1')
const liveOffer = (h: Harness) => {
  h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  h.head()
  h.mine(h.candidate('0xpublish').hash)
}

const cancelAll = (h: Harness): PlanInput => ({
  intentId: 'cancel',
  steps: [
    {
      kind: 'tx',
      payload: encodeCall(W.midnight, 'setConsumed', {
        group: 'g1',
        amount: (1n << 128n) - 1n,
        onBehalf: W.account
      })
    }
  ],
  notAfter: 1_000_000,
  basisBlock: h.block
})

describe('lifecycle', () => {
  it('recovery that hits its bound stops unsafe, keeps everything durable, and gates the next start', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.send({ type: 'Stop' })
    h.drive('timeout')
    expect(h.entry(G1)?.state).toBe('revoking')
    h.tick(60_000)
    const report = h.commands('report').at(-1)
    expect(report).toMatchObject({
      outcome: 'unsafe',
      reason: 'recovery bound exceeded',
      open: { entries: [G1], nonces: [0, 1] }
    })
    expect(h.disk).toContain(G1)
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    h.observe(G1)
    expect(h.state.lifecycle.kind).toBe('starting')
    expect(h.commands('findNonceTx')).toEqual([{ type: 'findNonceTx', nonce: 0 }])
    h.mine(h.candidate('0xpublish').hash)
    expect(h.state.lifecycle.kind).toBe('running')
    expect(latched(h.state)).toBe(true)
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:new', tree(offer('g2', 5n))) })
    expect(h.notices('q:new')).toEqual(['refused'])
    expect(h.refusal('q:new')?.code).toBe('unauthorized')
  })

  it('stop abandons unexposed work at once and never reports clean while an entry is open', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.send({ type: 'Stop' })
    expect(h.notices('liq')).toEqual(['admitted', 'abandoned'])
    h.head()
    expect(h.commands('report')).toHaveLength(0)
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(h.commands('report')).toHaveLength(0)
    h.finalize(h.block)
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.commands('report').at(-1)).toMatchObject({
      outcome: 'clean',
      open: { entries: [], nonces: [] }
    })
  })

  it('handing a signature to an offchain API is exposure: it is flushed first and survives a crash', () => {
    const h = new Harness().start()
    const plan: PlanInput = {
      intentId: 'q',
      steps: [
        { kind: 'sign', payload: signTree(T), witness: T },
        {
          kind: 'release',
          payload: {
            kind: 'release',
            channel: 'midnight-api',
            message: { root: treeRoot(T), signature: `sig(${treeRoot(T)})` }
          },
          witness: T
        }
      ],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.sign()
    expect(h.commands('release')).toHaveLength(0)
    expect(h.entry(G1)?.state).toBe('exposed')
    h.flush()
    expect(h.commands('release')).toHaveLength(1)
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0)
    h.observe(G1)
    expect(h.entry(G1)?.state).toBe('exposed')
    expect(h.available(W.loan)).toBe(700n)
  })

  it('a submission identity is answered idempotently across a crash instead of re-executed', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('saga:1:step:0', { submissionId: 'saga-1/0' }) })
    expect(querySubmission(h.state, 'saga-1/0')).toBe('in-progress')
    h.drive()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0, 1)
    expect(querySubmission(h.state, 'saga-1/0')).toBe('interrupted')
    h.send({
      type: 'Submit',
      plan: {
        ...liquidationPlan('saga:1:step:0', { submissionId: 'saga-1/0' }),
        intentId: 'saga:1:step:0:retry'
      }
    })
    expect(h.commands('notify').at(-1)).toMatchObject({ notice: 'known', reason: 'interrupted' })
    expect(h.pending('simulate')).toHaveLength(0)
  })

  it('a crash before any exposure leaves no submission record, so resubmission is safe', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('saga:2:step:0', { submissionId: 'saga-2/0' }) })
    h.simulate()
    h.flush()
    expect(h.pending('sign')).toHaveLength(1)
    expect(h.commands('flush').some(c => 'saga-2/0' in c.ledger.submissions)).toBe(false)
    h.crash()
    h.boot()
    expect(querySubmission(h.state, 'saga-2/0')).toBe('unknown')
  })

  it('a crash after the first exposure keeps the submission record, so resubmission is refused', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('saga:2:step:0', { submissionId: 'saga-2/0' }) })
    h.simulate()
    h.sign()
    h.flush()
    expect(h.commands('flush').at(-1)!.ledger.submissions).toHaveProperty(['saga-2/0'])
    h.crash()
    h.boot()
    expect(querySubmission(h.state, 'saga-2/0')).toBe('interrupted')
  })

  it('a fenced flush stops at once without broadcasting', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    const seq = h.commands('flush').at(-1)!.seq
    h.send({ type: 'FlushFailed', seq, reason: 'fenced' })
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'unsafe' })
    expect(h.commands('broadcast')).toHaveLength(0)
  })

  it('a stopped kernel sends nothing, even a cancel whose signature and flush arrive late', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.send({ type: 'Submit', plan: cancelAll(h) })
    h.simulate()
    expect(h.pending('sign')).toHaveLength(1)
    h.send({ type: 'FlushFailed', seq: h.state.seq, reason: 'fenced' })
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped' })
    h.sign()
    h.send({ type: 'Flushed', seq: 1_000 })
    expect(h.commands('broadcast').filter(c => c.hash.startsWith('0xsetConsumed'))).toHaveLength(0)
  })

  it('a stopped kernel sends nothing, even a cancel whose own flush lands after an earlier one was fenced', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.send({ type: 'Submit', plan: cancelAll(h) })
    h.simulate()
    h.sign()
    const seq = h.commands('flush').at(-1)!.seq
    h.send({ type: 'FlushFailed', seq: seq - 1, reason: 'fenced' })
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped' })
    h.send({ type: 'Flushed', seq })
    expect(h.commands('broadcast').filter(c => c.hash.startsWith('0xsetConsumed'))).toHaveLength(0)
  })

  it('a halt from anywhere in the bot is a stop: one recovery, the same terminal predicate', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.send({ type: 'Halt', reason: 'readiness: allowance' })
    h.send({ type: 'Halt', reason: 'second signal' })
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'readiness: allowance' })
    expect(h.pending('simulate')).toHaveLength(1)
  })

  it('a second submission with the same id before any commit is answered, not executed', () => {
    const h = new Harness().start()
    const first = liquidationPlan('a', { submissionId: 'saga/0' })
    h.send({ type: 'Submit', plan: first })
    h.send({ type: 'Submit', plan: { ...first, intentId: 'a-retry' } })
    expect(h.commands('notify').at(-1)).toMatchObject({
      intentId: 'a-retry',
      notice: 'known',
      reason: 'in-progress'
    })
    h.send({ type: 'Submit', plan: liquidationPlan('b', { submissionId: 'saga/0' }) })
    expect(h.commands('notify').at(-1)).toMatchObject({
      intentId: 'b',
      notice: 'refused',
      code: 'duplicate',
      reason: 'submission saga/0 conflicts with its first payload'
    })
    h.drive()
    expect(h.broadcastsTo('exec')).toHaveLength(1)
    expect(h.candidates().map(c => c.intentId)).toEqual(['a'])
  })

  it('after a restart a conflicting resubmission of an exposed submission is refused', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('a', { submissionId: 'saga/0' }) })
    h.drive()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0, 1)
    h.send({ type: 'Submit', plan: liquidationPlan('b', { submissionId: 'saga/0' }) })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'duplicate',
      reason: 'submission saga/0 conflicts with its first payload'
    })
  })

  it('clean is reported only after the final flush is acknowledged', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.finalize(h.block)
    h.send({ type: 'Stop' })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.reports()).toHaveLength(0)
    expect(h.disk).toContain(G1)
    h.flush()
    expect(h.disk).not.toContain(G1)
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'clean' })
  })

  it('a failed final flush is an unsafe stop', () => {
    const h = new Harness().start()
    liveOffer(h)
    h.finalize(h.block)
    h.send({ type: 'Stop' })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.finalize(h.block)
    const last = h.commands('flush').at(-1)!
    h.send({ type: 'FlushFailed', seq: last.seq, reason: 'io' })
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'unsafe' })
  })
})
