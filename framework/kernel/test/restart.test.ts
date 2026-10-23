import { describe, expect, it } from 'vitest'

import type { KernelConfig, Validator } from '../src'

import { latched } from '../src'
import { fnOf } from './codec'
import {
  cancel,
  ecrecoverPlan,
  liquidationPlan,
  makeConfig,
  offer,
  publish,
  setterPlan,
  T,
  transfer,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
const G2 = midnightId('g2')

/** Publishes one 300-unit offer per group, each in its own plan, and makes them final and durable. */
const withLiveOffers = (...groups: string[]) => {
  const h = new Harness().start()
  for (const group of groups) {
    h.liveOffer(tree(offer(group, 300n)), `q:${group}`)
    h.finalize(h.block)
  }
  h.flush()
  return h
}

const withLiveOffer = () => new Harness().start().liveOffer()

const restart = (h: Harness, config: KernelConfig = h.config) => {
  h.redeploy(config)
  h.boot()
  h.head()
  h.nonceAt(h.state.nextNonce!)
  for (const id of Object.keys(h.state.entries)) h.observe(id)
}

const withdrawals = (h: Harness) =>
  h
    .commands('notify')
    .filter(c => c.notice === 'compensating')
    .map(c => c.reason)

const cancelsPending = (h: Harness) =>
  h.pending('simulate').filter(c => fnOf(c.payload) === 'setConsumed').length

describe('a restart keeps what it can attribute and never extends it unasked', () => {
  it('keeps a live commitment the current policy still allows', () => {
    const h = withLiveOffers('g1')
    restart(h)
    expect(h.state.lifecycle.kind).toBe('running')
    expect(h.entry(G1)?.state).toBe('live')
    expect(withdrawals(h)).toEqual([])
    expect(cancelsPending(h)).toBe(0)
  })

  it('withdraws a commitment the current validator refuses', () => {
    const h = withLiveOffers('g1')
    restart(h, makeConfig({ markets: [] }))
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G1}: policy now refuses: market M1 not allowlisted`
    ])
    expect(h.state.lifecycle.kind).toBe('running')
    expect(cancelsPending(h)).toBe(1)
  })

  it('withdraws a commitment whose creating target the current policy no longer allows', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: setterPlan('q:g1', tree(offer('g1', 300n, { ratifier: W.setter })))
    })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.finalize(h.block)
    h.flush()
    const config = makeConfig()
    restart(h, {
      ...config,
      policy: { ...config.policy, targets: config.policy.targets.filter(t => t !== W.setter) }
    })
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G1}: policy now refuses: policy: target ${W.setter}`
    ])
    expect(cancelsPending(h)).toBe(1)
  })

  it('withdraws a commitment the current validator reads as larger than recorded', () => {
    const h = withLiveOffers('g1')
    const config = makeConfig()
    const honest = config.validators[0]!
    const inflating: Validator = {
      ...honest,
      read: (payload, evidence, context) => {
        const reading = honest.read(payload, evidence, context)
        return reading.ok
          ? { ...reading, creates: reading.creates.map(c => ({ ...c, cap: c.cap + 1n })) }
          : reading
      }
    }
    restart(h, { ...config, validators: [inflating, ...config.validators.slice(1)] })
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G1}: the validator now reads it beyond its recorded bounds`
    ])
  })

  it('withdraws a commitment the current validator reads with another exposure mode', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: setterPlan('q:g1', tree(offer('g1', 300n, { ratifier: W.setter })))
    })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.finalize(h.block)
    h.flush()
    expect(h.entry(G1)?.spec.exposure).toBe('inclusion')
    const config = makeConfig()
    const honest = config.validators[0]!
    const broadcasting: Validator = {
      ...honest,
      read: (payload, evidence, context) => {
        const reading = honest.read(payload, evidence, context)
        return reading.ok
          ? {
              ...reading,
              creates: reading.creates.map(c => ({ ...c, exposure: 'broadcast' as const }))
            }
          : reading
      }
    }
    restart(h, { ...config, validators: [broadcasting, ...config.validators.slice(1)] })
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G1}: the validator now reads its exposure differently`
    ])
  })

  it('trims, in order, the commitments that together exceed a lowered cap', () => {
    const h = withLiveOffers('g1', 'g2')
    restart(h, makeConfig({ caps: { [W.loan]: 500n, native: 100n * 10n ** 15n } }))
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G2}: with what is kept and in flight it exceeds the ${W.loan} cap`
    ])
    expect(h.entry(G1)?.compensate).toBe(false)
    expect(h.entry(G2)?.compensate).toBe(true)
    expect(cancelsPending(h)).toBe(1)
  })

  it.each([
    [350n, []],
    [
      349n,
      [`restart withdraws ${G2}: with what is kept and in flight it exceeds the ${W.loan} cap`]
    ]
  ])('counts only what is left after final fills against a cap of %s', (cap, expected) => {
    const h = withLiveOffers('g1', 'g2')
    h.observe(G1, 250n)
    h.finalize(h.block)
    h.flush()
    restart(h, makeConfig({ caps: { [W.loan]: cap, native: 100n * 10n ** 15n } }))
    expect(withdrawals(h)).toEqual(expected)
  })

  it('counts what pending transactions hold against the cap', () => {
    const h = withLiveOffers('g1')
    h.send({
      type: 'Submit',
      plan: {
        intentId: 't',
        steps: [{ kind: 'tx', payload: transfer(300n) }],
        notAfter: 1_000_000,
        basisBlock: h.block
      }
    })
    h.drive('timeout')
    h.flush()
    restart(h, makeConfig({ caps: { [W.loan]: 500n, native: 100n * 10n ** 15n } }))
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G1}: with what is kept and in flight it exceeds the ${W.loan} cap`
    ])
  })

  it('withdraws a revoking commitment the current policy refuses once its cancellation loses', () => {
    const h = withLiveOffers('g1')
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'c',
        steps: [{ kind: 'tx', payload: cancel() }],
        notAfter: 1_000_000,
        basisBlock: h.block
      }
    })
    h.drive()
    expect(h.entry(G1)?.state).toBe('revoking')
    h.flush()
    restart(h, makeConfig({ markets: [] }))
    expect(withdrawals(h)).toEqual([
      `restart withdraws ${G1}: policy now refuses: market M1 not allowlisted`
    ])
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash, { status: 'reverted' })
    expect(h.entry(G1)?.state).toBe('live')
    expect(cancelsPending(h)).toBe(1)
  })

  it('withdraws a commitment the bot stops re-affirming, however often it restarts', () => {
    const h = withLiveOffers('g1')
    const quarter = h.config.revokeAfterStaleMs / 4
    for (let i = 0; i < 4; i++) {
      h.tick(quarter)
      h.head()
      h.flush()
      restart(h)
      expect(cancelsPending(h)).toBe(0)
    }
    h.tick(quarter)
    expect(cancelsPending(h)).toBe(1)
  })
})

describe('validators read evidence as a restart will', () => {
  const cyclic = () => {
    const t: Record<string, unknown> = { ...tree(offer('g1', 300n)) }
    t.self = t
    return t
  }

  it('refuses a plan whose evidence the ledger cannot carry', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', cyclic() as never) })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'malformed',
      reason: 'step does not survive the ledger codec'
    })
  })

  it('fails a step materialized with evidence the ledger cannot carry', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), cyclic())
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'abandoned',
      reason: 'step does not survive the ledger codec'
    })
  })

  it('hands the validator evidence in the form a restart reads back', () => {
    const config = makeConfig()
    const honest = config.validators[0]!
    const seen: unknown[] = []
    const spying: Validator = {
      ...honest,
      read: (payload, evidence, context) => {
        seen.push(evidence)
        return honest.read(payload, evidence, context)
      }
    }
    const t = tree(offer('g1', 300n))
    const h = new Harness({ ...config, validators: [spying, ...config.validators.slice(1)] })
    h.start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', { ...t, note: new Map() } as never) })
    expect(seen).not.toHaveLength(0)
    expect(seen.every(e => !((e as { note: unknown }).note instanceof Map))).toBe(true)
  })
})

describe('a restart resumes the recovery and bounds it stopped under', () => {
  it('a restart does not restart the latch bound', () => {
    const h = withLiveOffer()
    h.tick(3_000_000)
    h.send({ type: 'Submit', plan: liquidationPlan('liq', { notAfter: 10_000_000 }) })
    h.drive('timeout')
    const unknownAt = h.block
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    h.mine(h.candidate('0xpublish').hash)
    h.observe(G1)
    expect(h.state.lifecycle.kind).toBe('running')
    while (h.block - unknownAt <= 10) h.head()
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'latch bound exceeded' })
  })

  it('a restart does not extend an unaffirmed offer past its stale bound', () => {
    const h = withLiveOffer()
    h.tick(3_000_000)
    h.head()
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    h.mine(h.candidate('0xpublish').hash)
    h.observe(G1)
    expect(h.pending('simulate')).toHaveLength(0)
    h.tick(700_000)
    expect(fnOf(h.pending('simulate')[0]?.payload)).toBe('setConsumed')
  })

  it('a foreign record reloaded at startup puts the kernel back in bounded recovery', () => {
    const h = new Harness().start()
    h.nonceAt(0, 1)
    h.flush()
    expect(h.disk).toContain('"foreign":true')
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0, 1)
    expect(latched(h.state)).toBe(true)
    expect(h.state.lifecycle.kind).toBe('recovering')
    for (let i = 0; i < 20; i++) h.head()
    expect(h.reports()).toHaveLength(0)
    h.tick(60_000)
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'unsafe', open: { nonces: [0] } })
  })

  it('restored recovery names its reason and keeps the latch age', () => {
    const config = makeConfig({ recoveryBoundMs: 10_000_000 })
    const h = new Harness(config).start()
    h.nonceAt(0, 1)
    expect(h.state.nonces[0]?.unknownSince).toBe(1)
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0, 1)
    expect(h.state.lifecycle).toMatchObject({
      kind: 'recovering',
      reason: 'foreign nonce outstanding at start'
    })
    expect(h.block).toBe(2)
    expect(h.state.nonces[0]?.unknownSince).toBe(1)
  })

  it('a restart after a foreign transaction took one of our nonces comes back recovering', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive()
    h.head()
    h.nonceAt(1)
    h.send({
      type: 'NonceTx',
      nonce: 0,
      hash: '0xforeign',
      block: h.block,
      blockHash: h.hash(h.block),
      status: 'success',
      logs: []
    })
    h.finalize(h.block)
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    expect(h.state.nonces[0]?.candidates.map(c => c.intentId)).toStrictEqual(['liq'])
    expect(h.state.nonces[0]?.resolution).toBeUndefined()
    expect(h.commands('findNonceTx').at(-1)).toMatchObject({ nonce: 0 })
    h.send({
      type: 'NonceTx',
      nonce: 0,
      hash: '0xforeign',
      block: h.block,
      blockHash: h.hash(h.block),
      status: 'success',
      logs: []
    })
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering' })
    expect(h.state.nonces[0]?.resolution?.winner).toBeNull()
  })

  it('a restart holding a foreign record recovers without waiting for its lookup', () => {
    const h = new Harness().start()
    h.head()
    h.nonceAt(1)
    expect(h.state.nonces[0]?.foreign).toBe(true)
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    expect(h.state.lifecycle).toMatchObject({
      kind: 'recovering',
      reason: 'foreign nonce outstanding at start'
    })
  })

  it('a restart that never sees its offer observed still withdraws it once affirmation lapses', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.finalize(h.block)
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    expect(h.state.lifecycle.kind).toBe('starting')
    h.tick(3_700_000)
    expect(h.state.lifecycle).toMatchObject({
      kind: 'recovering',
      reason: 'affirmation lapsed during startup'
    })
    expect(fnOf(h.pending('simulate')[0]?.payload)).toBe('setConsumed')
  })
})
