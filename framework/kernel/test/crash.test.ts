import { describe, expect, it } from 'vitest'

import type { DecisionRecord } from '../src'

import { ecrecoverPlan, FRESH_UNTIL, liquidationPlan, publish, T, W } from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
/** Runs an ecrecover plan up to the publish transaction's commit point (flush emitted, not written). */
const toPublishCommit = () => {
  const h = new Harness().start()
  h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.simulate()
  h.sign()
  return h
}

/** Reboots from disk and feeds the startup reads a runtime's kernel sources would. */
const reboot = (h: Harness, { latest = 0, observe = true } = {}) => {
  h.crash()
  h.boot()
  h.head()
  h.nonceAt(latest)
  if (observe) for (const id of Object.keys(h.state.entries)) h.observe(id)
}

describe('crash boundaries', () => {
  it('before any signature: nothing is durable, the reservation is gone, the nonce is reused', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    expect(h.pending('simulate')).toHaveLength(1)
    reboot(h)
    expect(h.state.lifecycle.kind).toBe('running')
    expect(h.state.entries).toEqual({})
    expect(h.state.nonces).toEqual({})
    expect(h.state.nextNonce).toBe(0)
  })

  it('after a typed signature but before its release: the signature died with the process', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
    h.sign()
    expect(h.entry(G1)?.state).toBe('signed')
    reboot(h)
    expect(h.state.entries).toEqual({})
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('after the flush: the candidate reads back with the evidence and decision it went on, and no authority', () => {
    const h = new Harness().start()
    const fact = { id: 'liquidatable/p1', version: 'v1', basis: { block: 1, blockHash: h.hash(1) } }
    const decision = { key: 'p1', bid: '42' }
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq:K1', { evidence: [fact], decision, notAfter: FRESH_UNTIL }),
      observations: [{ id: fact.id, version: 'v1' }]
    })
    h.simulate()
    h.sign()
    h.flush()
    expect(h.disk).toContain('liquidatable/p1')
    reboot(h)
    expect(h.candidate('0xexec:liq:K1')).toMatchObject({
      sent: 'unknown',
      authority: { evidence: [fact], decision }
    })
    expect(h.state.plans).toEqual({})
    expect(h.state.observations).toEqual({})
  })

  it('records a decision whose keys look like codec tags, and refuses one too wide or too large', () => {
    const refusals = (
      [
        { $bigint: '42' },
        { $bigint: 'oops' },
        { ['k'.repeat(65)]: 1 },
        Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, 'x'.repeat(256)]))
      ] as const
    ).map((decision, i) => {
      const h = new Harness().start()
      h.send({ type: 'Submit', plan: liquidationPlan(`liq:${i}`, { decision }) })
      const last = h.commands('notify').at(-1)
      return last?.reason ?? last?.notice
    })
    expect(refusals).toStrictEqual([
      'admitted',
      'admitted',
      'decision record is not a few named scalars',
      'authority is too large to record'
    ])
  })

  it('bounds the authority as the ledger records it, and restarts from one at the bound', () => {
    const recordOf = (length: number): DecisionRecord => {
      const decision: Record<string, string> = Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 'x'.repeat(256)])
      )
      decision.last = ''
      const base = JSON.stringify({ evidence: [], decision }).length
      decision.last = 'y'.repeat(length - base)
      return decision
    }
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('over', { decision: recordOf(4_097) }) })
    expect(h.commands('notify').at(-1)?.reason).toBe('authority is too large to record')
    const atBound = recordOf(4_096)
    h.send({ type: 'Submit', plan: liquidationPlan('at the bound', { decision: atBound }) })
    expect(h.notices('at the bound')).toEqual(['admitted'])
    h.drive()
    reboot(h, { latest: 0 })
    expect(h.state.lifecycle.kind).not.toBe('stopped')
    expect(h.candidates()[0]?.authority).toStrictEqual({ evidence: [], decision: atBound })
  })

  it('restarts cleanly from every decision record it admitted', () => {
    const h = new Harness().start()
    const decisions: DecisionRecord[] = [
      { key: 'p1', bid: '42', why: 'quote "ok" \\ é \u{1f680}', n: -1.5, flag: false, empty: '' },
      { 'with space': 0, nested: '{"$bigint":"1"}' }
    ]
    for (const [i, decision] of decisions.entries()) {
      h.send({ type: 'Submit', plan: liquidationPlan(`liq:${i}`, { decision }) })
      h.drive()
    }
    reboot(h, { latest: 0 })
    expect(h.state.lifecycle.kind).not.toBe('stopped')
    expect(h.candidates().map(c => c.authority?.decision)).toStrictEqual(decisions)
  })

  it('loads a ledger whose recorded authority names no block, since it authorizes nothing again', () => {
    const h = new Harness().start()
    const fact = { id: 'liquidatable/p1', version: 'v1', basis: { block: 1, blockHash: h.hash(1) } }
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq:K1', { evidence: [fact], notAfter: FRESH_UNTIL }),
      observations: [{ id: fact.id, version: 'v1' }]
    })
    h.simulate()
    h.sign()
    h.flush()
    h.disk = h.disk!.replace(/,"basis":\{[^}]*\}/, '')
    reboot(h)
    expect(h.state.lifecycle.kind).not.toBe('stopped')
    expect(h.candidate('0xexec:liq:K1').authority?.evidence).toStrictEqual([
      { id: fact.id, version: 'v1' }
    ])
  })

  it('refuses a ledger whose candidate carries a malformed authority', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq:K1', { decision: { key: 'p1' } })
    })
    h.simulate()
    h.sign()
    h.flush()
    h.disk = h.disk!.replace('"decision":{"key":"p1"}', '"decision":{"key":{"nested":true}}')
    h.crash()
    h.boot()
    expect(h.reports().at(-1)).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('decision record is not a few named scalars')
    })
  })

  it('after the commit point but before the flush is written: nothing left the process', () => {
    const h = toPublishCommit()
    expect(h.commands('flush').at(-1)?.ledger.entries[G1]?.state).toBe('exposed')
    reboot(h)
    expect(h.state.entries).toEqual({})
    expect(h.state.nextNonce).toBe(0)
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('after the flush is written but before the broadcast: exposure is assumed, latched, and neutralized', () => {
    const h = toPublishCommit()
    h.flush({ ack: false })
    expect(h.commands('broadcast')).toHaveLength(0)
    reboot(h)
    expect(h.entry(G1)?.state).toBe('exposed')
    expect(h.candidate('0xpublish').sent).toBe('unknown')
    expect(h.state.lifecycle.kind).toBe('running')
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    expect(h.notices('liq:K1')).toEqual(['refused'])
    for (let i = 0; i < 12; i++) h.head()
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'latch bound exceeded' })
    h.drive()
    const neutralizer = h.candidate('0xsetConsumed')
    expect(neutralizer.nonce).toBe(0)
    expect(h.entry(G1)?.state).toBe('revoking')
    h.head()
    h.mine(neutralizer.hash)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'clean' })
  })

  it('after the broadcast but before its result: the landed publish is found and adopted', () => {
    const h = toPublishCommit()
    h.flush()
    expect(h.commands('broadcast')).toHaveLength(1)
    const hash = h.candidate('0xpublish').hash
    h.crash()
    h.boot()
    h.head()
    h.mine(hash)
    h.nonceAt(1)
    expect(h.state.lifecycle.kind).toBe('starting')
    h.observe(G1)
    expect(h.state.lifecycle.kind).toBe('running')
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.available(W.loan)).toBe(700n)
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
    expect(h.notices('q:M1')).toEqual(['refused'])
  })

  it('after a neutralizer is flushed but before it is sent: the stored bytes are re-sent, not re-derived', () => {
    const h = toPublishCommit()
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.send({ type: 'Stop' })
    h.simulate()
    h.sign()
    h.flush({ ack: false })
    const stored = h.candidate('0xsetConsumed')
    h.redeploy(h.config)
    h.boot()
    h.head()
    h.nonceAt(1)
    h.observe(G1)
    expect(h.entry(G1)?.state).toBe('revoking')
    for (let i = 0; i < 3; i++) h.head()
    expect(h.commands('broadcast').map(c => c.raw)).toEqual([stored.raw])
    expect(h.commands('sign')).toHaveLength(0)
  })

  it('after retirement but before the lazy flush: the stale ledger re-learns the retirement from the chain', () => {
    const h = toPublishCommit()
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.finalize(h.block)
    h.flush()
    h.observe(G1, 0n, true)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.disk).toContain(G1)
    reboot(h, { latest: 1, observe: false })
    h.observe(G1, 0n, true)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.state.lifecycle.kind).toBe('running')
  })
})
