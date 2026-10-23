import { describe, expect, it } from 'vitest'

import type { Fact, Observation, PlanInput, ReleasePayload } from '../src'

import { latched } from '../src'
import { fnOf } from './codec'
import {
  cancel,
  FEE,
  FRESH_UNTIL,
  makeConfig,
  offer,
  publish,
  ratify,
  setterPlan,
  signTree,
  transfer,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId, treeRoot } from './validators'

const FACT = 'desire/ladder:M1'
const BOOK = 'quoter:book'
const G1 = midnightId('g1')
const T = tree(offer('g1', 300n, { ratifier: W.setter }))
const T2 = tree(offer('g2', 300n, { ratifier: W.setter }))

const desired = (h: Harness, version = 'T', block = h.block): Fact => ({
  id: FACT,
  version,
  basis: { block, blockHash: h.hash(block) }
})

const seen = (version = 'T'): Observation => ({ id: FACT, version, expiry: FRESH_UNTIL })

/** Ratify then publish, resting on the decision still desiring the tree, as the quoter submits it. */
const workflow = (h: Harness, intentId: string, extra: Partial<PlanInput> = {}): PlanInput => ({
  ...setterPlan(intentId, T),
  basisBlock: h.block,
  evidence: [desired(h)],
  conflicts: { writes: [BOOK] },
  ...extra
})

const reasons = (h: Harness, intentId: string) =>
  h
    .commands('notify')
    .filter(c => c.intentId === intentId)
    .map(c => c.reason)

/** A workflow whose ratification is included at the returned block, parked awaiting publication. */
const ratified = (extra: Partial<PlanInput> = {}) => {
  const h = new Harness().start()
  h.send({ type: 'Submit', plan: workflow(h, 'q', extra), observations: [seen()] })
  h.drive()
  h.head()
  h.mine(h.candidate('0xsetIsRootRatified').hash)
  return { h, at: h.block }
}

const neverOverdrawn = (h: Harness) => {
  for (const resource of Object.keys(h.config.caps)) {
    expect(h.available(resource), resource).toBeGreaterThanOrEqual(0n)
  }
}

const published = (h: Harness, intentId = 'q') =>
  h.commands('simulate').filter(c => c.intentId === intentId && fnOf(c.payload) === 'publish')

describe('a workflow across stages', () => {
  it('survives its own ratification, and publishes only on fresh publication-stage evidence', () => {
    const { h, at } = ratified()
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    h.send({ type: 'Observed', observations: [seen('T')] })
    h.head()
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    expect(published(h)).toHaveLength(0)

    h.advance('q', { evidence: [desired(h, 'T', at - 1)], observations: [seen()] })
    expect(h.notices('q').at(-1)).toBe('stalled')
    expect(reasons(h, 'q').at(-1)).toBe(`evidence ${FACT} predates our own inclusion`)
    h.advance('q', { evidence: [desired(h, 'T', at)], basisBlock: at - 1, observations: [seen()] })
    expect(reasons(h, 'q').at(-1)).toBe('decision predates our own inclusion')
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    expect(published(h)).toHaveLength(0)

    h.advance('q', { evidence: [desired(h)], observations: [seen()] })
    expect(h.notices('q').at(-1)).toBe('advanced')
    expect(published(h)).toHaveLength(1)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.notices('q')).toEqual(['admitted', 'stalled', 'stalled', 'advanced', 'settled'])
  })

  it('stalls a stage whose evidence names no block', () => {
    const { h } = ratified()
    h.advance('q', { evidence: [{ id: FACT, version: 'T' } as Fact], observations: [seen()] })
    expect(h.notices('q').at(-1)).toBe('stalled')
    expect(reasons(h, 'q').at(-1)).toBe('evidence names no block')
    expect(published(h)).toHaveLength(0)
  })

  it('stalls a stage whose evidence shadows the methods the kernel reads it with', () => {
    const { h } = ratified()
    const evidence = Object.assign([desired(h)], { map: 0, flatMap: 0 })
    h.advance('q', { evidence, observations: [seen()] })
    expect(reasons(h, 'q').at(-1)).toBe('evidence is not a list')
    expect(published(h)).toHaveLength(0)
  })

  it('keeps a stage whose evidence expires while its transaction is included, and advances on fresh evidence', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: workflow(h, 'q', { notAfter: h.now + 1_000 }),
      observations: [seen()]
    })
    h.drive()
    h.tick(5_000)
    h.send({ type: 'Observed', observations: [{ id: FACT, version: 'T', expiry: h.now + 1_000 }] })
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    expect(h.state.plans.q).toMatchObject({ status: 'executing', phase: 'awaiting-advance' })
    expect(h.notices('q')).toEqual(['admitted'])

    h.advance('q', { evidence: [desired(h)], notAfter: h.now - 1, observations: [seen()] })
    expect(reasons(h, 'q').at(-1)).toBe('evidence expired')
    h.advance('q', { evidence: [desired(h)], notAfter: h.now + 1_000, observations: [seen()] })
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.notices('q').at(-1)).toBe('settled')
  })

  it('ends a stage whose evidence lapsed while its transaction was included, even on fresh evidence', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: workflow(h, 'q', { notAfter: h.now + 1_000 }),
      observations: [{ id: FACT, version: 'T', expiry: h.now + 1_000 }]
    })
    h.drive()
    h.tick(5_000)
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    expect(h.notices('q')).toEqual(['admitted', 'compensating'])
    expect(reasons(h, 'q').at(-1)).toBe('evidence expired')
    h.advance('q', { evidence: [desired(h)], notAfter: h.now + 1_000, observations: [seen()] })
    expect(published(h)).toHaveLength(0)
  })

  it('waits for a read after the block its step lands in again after a reorg', () => {
    const { h, at } = ratified()
    const hash = h.candidate('0xsetIsRootRatified').hash
    h.reorg(at - 1)
    h.head()
    h.head()
    h.mine(hash)
    expect(h.state.plans.q?.lastInclusion).toBe(h.block)
    h.advance('q', { evidence: [desired(h, 'T', at)], basisBlock: at, observations: [seen()] })
    expect(h.notices('q').at(-1)).toBe('stalled')
    expect(reasons(h, 'q').at(-1)).toMatch(/inclusion/)
  })

  it('lives while its finished stage evidence is read again unchanged, and only that long', () => {
    const { h } = ratified()
    const read = (version: string, expiry: number) =>
      h.send({ type: 'Observed', observations: [{ id: FACT, version, expiry }] })
    read('T', 5_000)
    expect(h.state.plans.q?.notAfter).toBe(5_000)
    read('T', 9_000)
    expect(h.state.plans.q?.notAfter).toBe(9_000)
    h.tick(6_000)
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    read('T2', 20_000)
    expect(h.state.plans.q?.notAfter).toBe(9_000)
    h.tick(3_000)
    expect(h.notices('q').at(-1)).toBe('compensating')
    expect(reasons(h, 'q').at(-1)).toBe('evidence expired')
  })

  it('stays past its deadline once there, whatever a later read says', () => {
    const { h } = ratified()
    const read = (expiry: number) =>
      h.send({ type: 'Observed', observations: [{ id: FACT, version: 'T', expiry }] })
    h.tick(4_000)
    read(3_000)
    expect(h.state.plans.q?.notAfter).toBe(3_000)
    read(9_000)
    expect(h.state.plans.q?.notAfter).toBe(3_000)
    h.advance('q', { evidence: [desired(h)], notAfter: 20_000, observations: [seen()] })
    expect(reasons(h, 'q').at(-1)).toBe('evidence expired')
    expect(published(h)).toHaveLength(0)
  })

  it('never publishes once the decision moves past its band, and the superseding cancel is the compensation', () => {
    const { h } = ratified()
    h.send({ type: 'Observed', observations: [seen('T2')] })
    h.advance('q', { evidence: [desired(h)], observations: [] })
    expect(reasons(h, 'q').at(-1)).toBe(`evidence ${FACT} changed`)

    const successor: PlanInput = {
      intentId: 'q2',
      supersedes: 'q',
      steps: [
        { kind: 'tx', payload: cancel('g1') },
        { kind: 'tx', payload: ratify(treeRoot(T2)), witness: T2 },
        { kind: 'tx', payload: publish(T2), witness: T2 }
      ],
      notAfter: 1_000_000,
      basisBlock: h.block,
      evidence: [desired(h, 'T2')],
      conflicts: { writes: [BOOK] }
    }
    h.send({ type: 'Submit', plan: successor, observations: [seen('T2')] })
    expect(h.notices('q').at(-1)).toBe('compensating')
    expect(reasons(h, 'q').at(-1)).toBe('superseded by q2')
    expect(h.notices('q2')).toEqual(['admitted'])

    expect(h.entry(G1)).toMatchObject({ state: 'live', compensate: true })
    expect(Object.values(h.state.plans).filter(plan => plan.recovery)).toHaveLength(0)
    expect(h.available(W.loan)).toBe(400n)

    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(h.entry(G1)?.state).toBe('revoking')
    expect(h.available(W.loan)).toBe(400n)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.notices('q').at(-1)).toBe('compensated')
    expect(h.state.plans.q2?.phase).toBe('awaiting-advance')
    expect(published(h, 'q')).toHaveLength(0)
    expect(h.available(W.loan)).toBe(700n)
  })

  it('recovers what it superseded once the superseding plan fails before its cancel', () => {
    const { h } = ratified()
    h.send({ type: 'Observed', observations: [seen('T2')] })
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'q2',
        supersedes: 'q',
        steps: [{ kind: 'tx', payload: cancel('g1') }],
        notAfter: 1_000_000,
        basisBlock: h.block
      }
    })
    expect(h.notices('q2')).toEqual(['admitted'])
    h.simulate(false)
    expect(h.notices('q2').at(-1)).toBe('abandoned')
    const recovery = Object.values(h.state.plans).filter(plan => plan.recovery?.entry === G1)
    expect(recovery).toHaveLength(1)
  })

  it('refuses an advance for a stage the plan is not parked at', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: workflow(h, 'q'), observations: [seen()] })
    h.advance('q', { evidence: [desired(h)] })
    expect(reasons(h, 'q').at(-1)).toBe('not awaiting stage 0')
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q', { stage: 0, evidence: [desired(h)] })
    expect(reasons(h, 'q').at(-1)).toBe('not awaiting stage 0')
    h.advance('nobody', { stage: 1 })
    expect(reasons(h, 'nobody')).toEqual(['no executing plan'])
  })

  it('moves a parked plan by nothing but an advance for its own stage', () => {
    const { h } = ratified()
    h.send({ type: 'Observed', observations: [seen()] })
    h.send({ type: 'Affirm', ids: [G1] })
    h.head()
    h.tick(1_000)
    h.finalize(h.block)
    h.advance('q', { stage: 2, evidence: [desired(h)], observations: [seen()] })
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    expect(published(h)).toHaveLength(0)
    h.advance('q', { evidence: [desired(h)], observations: [seen()] })
    expect(published(h)).toHaveLength(1)
  })

  it('ends a parked workflow at its finished stage deadline, and recovery withdraws what it ratified', () => {
    const { h } = ratified()
    h.send({ type: 'Observed', observations: [{ id: FACT, version: 'T', expiry: 10_000 }] })
    h.tick(9_999)
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    h.tick(1)
    expect(h.notices('q').at(-1)).toBe('compensating')
    expect(reasons(h, 'q').at(-1)).toBe('evidence expired')
    const recovery = Object.values(h.state.plans).filter(plan => plan.recovery?.entry === G1)
    expect(recovery).toHaveLength(1)
  })

  it('the quoter flow, sign then API release then publish, publishes what it already released', () => {
    const h = new Harness().start()
    const T = tree(offer('g1', 300n))
    const signature = `sig(${treeRoot(T)})`
    const plan: PlanInput = {
      intentId: 'q',
      steps: [
        { kind: 'sign', payload: signTree(T), witness: T },
        {
          kind: 'release',
          payload: {
            kind: 'release',
            channel: 'midnight-api',
            message: { root: treeRoot(T), signature }
          },
          witness: T
        },
        { kind: 'tx', witness: T }
      ],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.sign()
    h.flush()
    h.release()
    h.head()
    h.advance('q')
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'settled'])
    expect(h.entry(G1)?.state).toBe('live')
    expect(latched(h.state)).toBe(false)
  })

  it('a second release of the same offer still goes out and frees the slot, so a later cancel can run', () => {
    const h = new Harness().start()
    const T = tree(offer('g1', 300n))
    const release: ReleasePayload = {
      kind: 'release',
      channel: 'midnight-api',
      message: { root: treeRoot(T), signature: `sig(${treeRoot(T)})` }
    }
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'q',
        steps: [
          { kind: 'sign', payload: signTree(T), witness: T },
          { kind: 'release', payload: release, witness: T },
          { kind: 'release', payload: release, witness: T }
        ],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.sign()
    h.flush()
    h.release()
    h.head()
    h.advance('q')
    h.flush()
    h.release()
    expect(h.commands('release')).toHaveLength(2)
    expect(h.state.slot).toBeUndefined()
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'settled'])
    h.tick(3_700_000)
    expect(fnOf(h.pending('simulate')[0]?.payload)).toBe('setConsumed')
  })
})

describe('a reservation across stages', () => {
  /** Ratify, then spend from the loan reserve: the spend is reserved from admission. */
  const spending = (h: Harness): PlanInput => ({
    ...workflow(h, 'q'),
    steps: [
      { kind: 'tx', payload: ratify(treeRoot(T)), witness: T },
      { kind: 'tx', payload: transfer(400n, 'spend') }
    ]
  })

  it('holds a later stage capacity while parked, and spends it on advance without re-checking', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: spending(h), observations: [seen()] })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    expect(h.available(W.loan)).toBe(300n)

    const other = (intentId: string, amount: bigint): PlanInput => ({
      intentId,
      steps: [{ kind: 'tx', payload: transfer(amount, intentId) }],
      notAfter: 1_000_000,
      basisBlock: h.block
    })
    h.send({ type: 'Submit', plan: other('greedy', 400n) })
    expect(reasons(h, 'greedy')).toEqual([`insufficient ${W.loan}`])
    h.send({ type: 'Submit', plan: other('rest', 300n) })
    expect(h.notices('rest')).toEqual(['admitted'])
    expect(h.available(W.loan)).toBe(0n)

    h.advance('q', { evidence: [desired(h)], observations: [seen()] })
    expect(h.notices('q').at(-1)).toBe('advanced')
    expect(h.commands('simulate').filter(c => c.intentId === 'q')).toHaveLength(2)
  })

  it('keeps only what was committed across a restart, with no authority to continue', () => {
    const { h } = ratified()
    h.flush()
    expect(h.available(W.loan)).toBe(700n)
    h.crash()
    h.boot()
    expect(h.entry(G1)).toMatchObject({ state: 'live', adopted: true })
    expect(h.state.plans.q).toBeUndefined()
    expect(h.available(W.loan)).toBe(700n)
    h.advance('q', { stage: 1, evidence: [desired(h)], observations: [seen()] })
    expect(reasons(h, 'q')).toEqual(['no executing plan'])
    expect(published(h)).toHaveLength(0)
  })

  it('a dependent step cannot spend the allowance a later known step was admitted with', () => {
    const h = new Harness(makeConfig({ caps: { [W.loan]: 100n, native: 100n * FEE } })).start()
    const plan: PlanInput = {
      intentId: 'x',
      steps: [{ kind: 'tx' }, { kind: 'tx', payload: transfer(100n, 'b') }],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    expect(h.notices('x')).toEqual(['admitted'])
    neverOverdrawn(h)
    h.materialize(() => transfer(100n, 'a'))
    neverOverdrawn(h)
    h.drive()
    neverOverdrawn(h)
    for (const c of h.candidates()) h.mine(c.hash)
    h.drive()
    neverOverdrawn(h)
    expect(h.broadcastsTo('transfer')).toHaveLength(0)
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'abandoned',
      reason: 'consumes beyond the admitted envelope'
    })
  })
})

describe('a kernel that is not taking requests', () => {
  it('answers a submission before it starts and after it stops, so no answer is left owed', () => {
    const h = new Harness()
    h.send({ type: 'Submit', plan: setterPlan('early', T) })
    h.send({ type: 'Advance', intentId: 'early', stage: 1, basisBlock: 0, notAfter: 1 })
    expect(h.notices('early')).toEqual(['refused', 'stalled'])
    expect(reasons(h, 'early')).toEqual(['idle', 'idle'])
    expect(h.activity.filter(a => a.type === 'notice')).toHaveLength(2)

    const stopped = new Harness(makeConfig()).start()
    stopped.send({ type: 'Stop' })
    expect(stopped.state.lifecycle.kind).toBe('stopped')
    stopped.send({ type: 'Submit', plan: setterPlan('late', T) })
    expect(stopped.notices('late')).toEqual(['refused'])
    expect(stopped.refusal('late')?.code).toBe('lifecycle')
  })
})
