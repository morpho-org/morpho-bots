import { describe, expect, it } from 'vitest'

import type { Fact, Observation, PlanInput } from '../src'

import { createKernel, latched } from '../src'
import { encodeCall } from './codec'
import {
  ecrecoverPlan,
  FEE,
  FRESH_UNTIL,
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

const FACT = 'liquidatable/p1'
const P1 = 'position:p1'
const fact = (h: Harness, version = 'v1', block = h.block): Fact => ({
  id: FACT,
  version,
  basis: { block, blockHash: h.hash(block) }
})

const seen = (version = 'v1', id = FACT): Observation => ({ id, version, expiry: FRESH_UNTIL })

/** A liquidation of p1 resting on p1 still being liquidatable, as the act library builds it. */
const liquidation = (h: Harness, intentId: string, extra: Partial<PlanInput> = {}): PlanInput =>
  liquidationPlan(intentId, {
    evidence: [fact(h)],
    conflicts: { writes: [P1] },
    ...extra
  })

const submit = (h: Harness, plan: PlanInput, observations: Observation[] = [seen()]) =>
  h.send({ type: 'Submit', plan, observations })

const change = (h: Harness, observation: Observation = seen('v2')) =>
  h.send({ type: 'Observed', observations: [observation] })

/** A live commitment the kernel owns, and a withdrawal plan that retires it. */
const liveEntry = () => {
  const h = new Harness().start()
  h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  h.head()
  h.mine(h.candidate('0xpublish').hash)
  expect(h.entry(midnightId('g1'))?.state).toBe('live')
  const withdrawal = (intentId: string, extra: Partial<PlanInput> = {}): PlanInput => ({
    intentId,
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
    basisBlock: 0,
    conflicts: { writes: ['book'] },
    ...extra
  })
  return { h, withdrawal }
}

describe('evidence at admission', () => {
  it('admits a plan whose facts arrive with it, and refuses one whose fact it never saw', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'seen'))
    expect(h.notices('seen')).toEqual(['admitted'])
    const elsewhere: Fact = { ...fact(h), id: 'liquidatable/p2' }
    const unseen = liquidation(h, 'unseen', {
      evidence: [elsewhere],
      conflicts: { writes: ['position:p2'] }
    })
    submit(h, unseen, [])
    expect(h.refusal('unseen')).toEqual({
      code: 'evidence_invalid',
      reason: 'evidence liquidatable/p2 unobserved'
    })
  })

  it('refuses a fact that is unknown or failed, or no longer at the version decided on', () => {
    for (const [observation, reason] of [
      [{ id: FACT, unavailable: 'failed' }, `evidence ${FACT} failed`],
      [{ id: FACT, unavailable: 'unknown' }, `evidence ${FACT} unknown`],
      [seen('v2'), `evidence ${FACT} changed`]
    ] as const) {
      const h = new Harness().start()
      submit(h, liquidation(h, 'liq'), [observation])
      expect(h.lastReason('liq')).toBe(reason)
    }
  })

  it('refuses a fact read at a block it does not hold, or on a branch that was orphaned', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'ahead', { evidence: [fact(h, 'v1', 5)] }))
    expect(h.refusal('ahead')).toEqual({
      code: 'evidence_invalid',
      reason: `evidence ${FACT} read at a block the kernel does not hold`
    })
    const read = fact(h)
    h.reorg(0)
    h.head(1)
    submit(h, liquidation(h, 'orphaned', { evidence: [read] }))
    expect(h.refusal('orphaned')).toEqual({
      code: 'evidence_invalid',
      reason: `evidence ${FACT} read on an orphaned block`
    })
  })

  it('refuses evidence on a conflict id read before our own effect on it was included', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'first'))
    h.drive()
    h.head()
    const before = h.block - 1
    h.mine(h.candidate('0xexec:first').hash)
    expect(h.notices('first')).toEqual(['admitted', 'settled'])
    expect(h.state.conflictMarks[P1]).toBe(h.block)
    submit(h, liquidation(h, 'stale', { evidence: [fact(h, 'v1', before)] }))
    expect(h.refusal('stale')).toEqual({
      code: 'evidence_predates_own_effect',
      reason: `evidence ${FACT} predates our own effect on ${P1}`
    })
    submit(h, liquidation(h, 'fresh'))
    expect(h.notices('fresh')).toEqual(['admitted'])
  })

  it('keeps an observation only while an executing plan rests on it', () => {
    const h = new Harness().start()
    change(h)
    expect(h.state.observations).toEqual({})
    submit(h, liquidation(h, 'liq'))
    expect(h.state.observations[FACT]).toEqual(seen())
    h.drive()
    h.head()
    h.mine(h.candidate('0xexec:liq').hash)
    expect(h.state.observations).toEqual({})
  })
})

describe('evidence before and after a nonce', () => {
  it('refuses a plan whose fact changes before it reaches the slot', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq'))
    change(h)
    h.simulate()
    expect(h.lastReason('liq')).toBe(`evidence ${FACT} changed`)
    expect(h.commands('sign')).toHaveLength(0)
  })

  it('tells the signer not to sign once a fact changed, and discards a signature that comes back', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    submit(h, liquidation(h, 'liq'))
    h.simulate()
    const [sign] = h.pending('sign')
    expect(kernel.signRefusal(h.state, sign!.request, h.now)).toBeUndefined()
    change(h)
    expect(kernel.signRefusal(h.state, sign!.request, h.now)).toBe(`evidence ${FACT} changed`)
    h.sign()
    expect(h.lastReason('liq')).toBe(`final check: evidence ${FACT} changed`)
    expect(h.candidates()).toEqual([])
    expect(h.state.nextNonce).toBe(0)
  })

  it('sends a neutral plan whose fact changed while its record was being written, leaving no hole', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq'))
    h.simulate()
    h.sign()
    expect(h.pending('broadcast')).toHaveLength(0)
    change(h)
    h.flush()
    h.broadcast()
    expect(h.candidate('0xexec:liq')).toMatchObject({ nonce: 0, sent: 'accepted' })
    expect(h.notices('liq')).toEqual(['admitted'])
  })

  it('withholds a risk-increasing plan whose fact changed while its record was being written', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    submit(h, { ...setterPlan('q', t), evidence: [fact(h)] })
    h.simulate()
    h.sign()
    change(h)
    h.flush()
    expect(h.pending('broadcast')).toHaveLength(0)
    expect(h.lastReason('q')).toBe(`withheld: evidence ${FACT} changed`)
  })

  it('does not advance past a typed signature once a fact it rests on changed', () => {
    const h = new Harness().start()
    submit(h, { ...ecrecoverPlan('q', T), evidence: [fact(h)] })
    expect(h.pending('sign')).toHaveLength(1)
    change(h)
    h.sign()
    expect(h.lastReason('q')).toBe(`final check: evidence ${FACT} changed`)
    expect(h.state.plans.q?.signatures ?? []).toEqual([])
    expect(h.pending('materialize')).toHaveLength(0)
  })
})

describe('conflicts and supersession', () => {
  it('admits plans on disjoint ids side by side, both sent before either receipt', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'a'))
    const other: Fact = { ...fact(h), id: 'liquidatable/p2' }
    submit(h, liquidation(h, 'b', { evidence: [other], conflicts: { writes: ['position:p2'] } }), [
      seen('v1', 'liquidatable/p2')
    ])
    submit(h, liquidation(h, 'again'))
    expect(h.refusal('again')).toEqual({ code: 'conflict', reason: 'conflicts with a' })
    h.drive()
    expect(h.candidates().map(c => [c.intentId, c.nonce, c.sent])).toEqual([
      ['a', 0, 'accepted'],
      ['b', 1, 'accepted']
    ])
  })

  it('refuses a plan that reads an id an executing plan writes, and the reverse', () => {
    const other: Fact = {
      id: 'liquidatable/p2',
      version: 'v1',
      basis: { block: 1, blockHash: 'b1' }
    }
    const reader = (h: Harness, intentId: string, conflicts: PlanInput['conflicts']) =>
      submit(
        h,
        liquidation(h, intentId, { evidence: [{ ...other, basis: fact(h).basis }], conflicts }),
        [seen('v1', 'liquidatable/p2')]
      )

    const writesFirst = new Harness().start()
    submit(writesFirst, liquidation(writesFirst, 'a'))
    reader(writesFirst, 'b', { reads: [P1], writes: ['position:p2'] })
    expect(writesFirst.refusal('b')).toEqual({ code: 'conflict', reason: 'conflicts with a' })

    const readsFirst = new Harness().start()
    reader(readsFirst, 'a', { reads: [P1], writes: ['position:p2'] })
    expect(readsFirst.state.plans.a?.status).toBe('executing')
    submit(readsFirst, liquidation(readsFirst, 'b'))
    expect(readsFirst.refusal('b')).toEqual({ code: 'conflict', reason: 'conflicts with a' })
  })

  it('sets a superseded plan aside before judging conflicts, and fails it only on admission', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'old'))
    const elsewhere = encodeCall('0xNowhere', 'exec', { tag: 'refused' })
    submit(
      h,
      liquidation(h, 'refused', { supersedes: 'old', steps: [{ kind: 'tx', payload: elsewhere }] })
    )
    expect(h.refusal('refused')).toEqual({
      code: 'unauthorized',
      reason: 'no validator recognizes the action'
    })
    expect(h.state.plans.old?.status).toBe('executing')
    submit(h, liquidation(h, 'new', { supersedes: 'old' }))
    expect(h.notices('new')).toEqual(['admitted'])
    expect(h.lastReason('old')).toBe('superseded by new')
    expect(h.notices('old')).toEqual(['admitted', 'abandoned'])
  })

  it('never supersedes a plan once its step is committed, so no nonce or slot is left behind', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'old'))
    h.simulate()
    h.sign()
    expect(h.state.plans.old?.phase).toBe('commit')
    submit(h, liquidation(h, 'new', { supersedes: 'old' }))
    expect(h.refusal('new')).toEqual({
      code: 'supersession',
      reason: 'old is past its commit and cannot be superseded'
    })
    h.flush()
    h.broadcast()
    expect(h.candidate('0xexec:old')).toMatchObject({ nonce: 0, sent: 'accepted' })
  })

  it('lets a risk-reducing plan supersede anything, and nothing else supersede it', () => {
    const { h, withdrawal } = liveEntry()
    submit(h, liquidation(h, 'act', { conflicts: { writes: ['book'] } }))
    submit(h, withdrawal('pull', { supersedes: 'act' }), [])
    expect(h.notices('pull')).toEqual(['admitted'])
    submit(h, liquidation(h, 'back', { conflicts: { writes: ['book'] }, supersedes: 'pull' }))
    expect(h.refusal('back')).toEqual({
      code: 'supersession',
      reason: 'only a risk-reducing plan supersedes a risk-reducing one'
    })
    submit(h, withdrawal('pull again', { supersedes: 'pull' }), [])
    expect(h.notices('pull again')).toEqual(['admitted'])
  })

  it('never refuses a risk-reducing plan for its evidence', () => {
    const { h, withdrawal } = liveEntry()
    submit(h, withdrawal('pull', { evidence: [fact(h)] }), [{ id: FACT, unavailable: 'failed' }])
    expect(h.notices('pull')).toEqual(['admitted'])
    h.drive()
    expect(h.candidate('0xsetConsumed')).toMatchObject({ sent: 'accepted' })
  })
})

describe('a quote deadline before and after a nonce', () => {
  it('refuses a plan whose deadline passed before commit, at the signer guard and at the clock', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    submit(h, liquidation(h, 'liq', { notAfter: h.now + 1_000 }))
    h.simulate()
    const [sign] = h.pending('sign')
    expect(kernel.signRefusal(h.state, sign!.request, h.now + 1_000)).toBe('evidence expired')
    h.tick(2_000)
    expect(h.lastReason('liq')).toBe('evidence expired')
    h.sign()
    expect(h.candidates()).toEqual([])
  })

  it('hands off a neutral plan whose deadline passed while its ledger write was held', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', { notAfter: h.now + 1_000 }))
    h.simulate()
    h.sign()
    h.tick(2_000)
    h.flush()
    h.broadcast()
    expect(h.candidate('0xexec:liq')).toMatchObject({ nonce: 0, sent: 'accepted' })
    expect(h.notices('liq')).toEqual(['admitted'])
  })
})

describe('the fee reserve of a nonce', () => {
  const oneSend = () => new Harness(makeConfig({ caps: { [W.loan]: 1000n, native: FEE } })).start()

  it('is freed once its transaction resolves, so the next act is admitted before finality', () => {
    const h = oneSend()
    h.send({ type: 'Submit', plan: liquidationPlan('first') })
    h.drive()
    h.send({ type: 'Submit', plan: liquidationPlan('waits') })
    expect(h.refusal('waits')).toEqual({ code: 'capacity', reason: 'insufficient native' })
    h.head()
    h.mine(h.candidate('0xexec:first').hash)
    expect(h.state.finalized.number).toBeLessThan(h.block)
    expect(h.available('native')).toBe(FEE)
    h.send({ type: 'Submit', plan: liquidationPlan('next') })
    expect(h.notices('next')).toEqual(['admitted'])
  })

  it('is held again when a reorg undoes the resolution, and admission respects it', () => {
    const h = oneSend()
    h.send({ type: 'Submit', plan: liquidationPlan('first') })
    h.drive()
    h.head()
    h.mine(h.candidate('0xexec:first').hash)
    expect(h.available('native')).toBe(FEE)
    h.reorg(h.block - 1)
    expect(h.state.nonces[0]?.resolution).toBeUndefined()
    expect(h.available('native')).toBe(0n)
    h.send({ type: 'Submit', plan: liquidationPlan('after the reorg') })
    expect(h.refusal('after the reorg')).toEqual({
      code: 'capacity',
      reason: 'insufficient native'
    })
  })

  it('can over-commit by one reserve across a reorg, and admits nothing until holds fall back', () => {
    const h = new Harness(makeConfig({ caps: { [W.loan]: 1000n, native: 2n * FEE } })).start()
    h.send({ type: 'Submit', plan: liquidationPlan('first') })
    h.drive()
    h.head()
    const first = h.candidate('0xexec:first').hash
    h.mine(first)
    h.send({ type: 'Submit', plan: liquidationPlan('a') })
    h.send({ type: 'Submit', plan: liquidationPlan('b') })
    expect([h.notices('a'), h.notices('b')]).toEqual([['admitted'], ['admitted']])
    h.reorg(h.block - 1)
    expect(h.available('native')).toBe(-FEE)
    h.send({ type: 'Submit', plan: liquidationPlan('c') })
    expect(h.refusal('c')).toEqual({ code: 'capacity', reason: 'insufficient native' })
    expect([h.state.plans.a?.status, h.state.plans.b?.status]).toEqual(['executing', 'executing'])
    h.head()
    h.mine(first)
    h.drive()
    h.head()
    h.mine(h.candidate('0xexec:a').hash)
    expect(h.available('native')).toBe(FEE)
    h.send({ type: 'Submit', plan: liquidationPlan('d') })
    expect(h.notices('d')).toEqual(['admitted'])
  })
})

describe('an act between its committed nonce and its handoff', () => {
  /** A transfer is risk-increasing: the validator reads it consuming the loan reserve. */
  const plans = {
    neutral: (h: Harness, notAfter: number) => liquidation(h, 'act', { notAfter }),
    increasing: (h: Harness, notAfter: number): PlanInput => ({
      ...liquidation(h, 'act', { notAfter }),
      steps: [{ kind: 'tx', payload: transfer(100n, 'act') }]
    })
  }
  /** Each stimulus, and an evidence deadline that only the deadline stimulus passes. */
  const stimuli = {
    'its fact changes': { deadlineMs: 10_000, apply: (h: Harness) => change(h) },
    'its evidence deadline passes': { deadlineMs: 1_000, apply: (h: Harness) => h.tick(1_000) },
    'a halt lands': {
      deadlineMs: 10_000,
      apply: (h: Harness) => h.send({ type: 'Halt', reason: 'operator' })
    },
    'its simulation is orphaned': {
      deadlineMs: 10_000,
      apply: (h: Harness) => {
        h.reorg(h.block - 1)
        h.head()
      }
    },
    'its dispatch window passes': {
      deadlineMs: 10_000,
      apply: (h: Harness) => h.tick(h.config.maxDispatchLagMs + 1)
    }
  }

  it.each([
    ['neutral', 'its fact changes', 'sent'],
    ['neutral', 'its evidence deadline passes', 'sent'],
    ['neutral', 'a halt lands', 'lifecycle forbids this action'],
    ['neutral', 'its simulation is orphaned', 'simulation orphaned by a reorg'],
    ['neutral', 'its dispatch window passes', 'dispatch window exceeded'],
    ['increasing', 'its fact changes', `evidence ${FACT} changed`],
    ['increasing', 'its evidence deadline passes', 'evidence expired'],
    ['increasing', 'a halt lands', 'lifecycle forbids this action'],
    ['increasing', 'its simulation is orphaned', 'simulation orphaned by a reorg'],
    ['increasing', 'its dispatch window passes', 'dispatch window exceeded']
  ] as const)('a %s act when %s: %s', (kind, stimulus, outcome) => {
    const h = new Harness().start()
    h.head()
    const { deadlineMs, apply } = stimuli[stimulus]
    submit(h, { ...plans[kind](h, h.now + deadlineMs), evidence: [fact(h, 'v1', h.block - 1)] })
    h.simulate()
    h.sign()
    expect(h.state.plans.act?.phase).toBe('commit')
    apply(h)
    h.flush()
    h.broadcast()
    const [sent] = h.candidates()
    if (outcome === 'sent') {
      expect(sent).toMatchObject({ nonce: 0, sent: 'accepted' })
      expect(h.notices('act')).toEqual(['admitted'])
    } else {
      expect(sent).toMatchObject({ nonce: 0, sent: 'withheld' })
      expect(h.lastReason('act')).toBe(`withheld: ${outcome}`)
    }
  })

  it('a fact that changes during the flush withholds a risk-increasing broadcast; the recorded nonce is filled', () => {
    const h = new Harness().start()
    const fact = {
      id: 'bridge/route',
      version: 'v1',
      basis: { block: h.block, blockHash: h.hash(h.block) }
    }
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'send',
        steps: [{ kind: 'tx', payload: transfer(100n, 'send') }],
        basisBlock: 0,
        evidence: [fact],
        notAfter: FRESH_UNTIL
      },
      observations: [fact]
    })
    h.simulate()
    h.sign()
    h.send({ type: 'Observed', observations: [{ ...fact, version: 'v2' }] })
    h.flush()
    expect(h.broadcastsTo('transfer')).toHaveLength(0)
    expect(h.candidate('0xtransfer').sent).toBe('withheld')
    expect(latched(h.state)).toBe(false)
    h.drive()
    const fill = h.candidate('0xfill')
    expect(fill.nonce).toBe(0)
    h.head()
    h.mine(fill.hash)
    h.finalize(h.block)
    expect(h.state.nonces).toEqual({})
    expect(h.notices('send')).toEqual(['admitted', 'compensating', 'compensated'])
  })

  it('a flush acknowledged after the dispatch bound withholds the act', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    h.tick(h.config.maxDispatchLagMs + 1)
    h.flush()
    expect(h.broadcastsTo('exec')).toHaveLength(0)
    expect(h.candidate('0xexec').sent).toBe('withheld')
  })
})

describe('a plan whose only cost is its fee', () => {
  it('reserves its fee, and is not withheld after commit for stale evidence or a passed deadline', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', { notAfter: h.now + 1_000 }))
    expect(h.state.plans.liq?.envelope).toEqual({ ids: [], consumes: {} })
    expect(h.available('native')).toBe(99n * FEE)
    h.simulate()
    h.sign()
    change(h)
    h.tick(2_000)
    h.flush()
    h.broadcast()
    expect(h.candidate('0xexec:liq')).toMatchObject({ sent: 'accepted' })
  })

  it('is still new work: refused while the kernel is latched or recovering', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'unknown send'))
    h.drive('unknown')
    submit(h, liquidation(h, 'while latched', { conflicts: { writes: ['position:p2'] } }))
    expect(h.notices('while latched')).toEqual(['refused'])
    expect(h.refusal('while latched')).toEqual({
      code: 'unauthorized',
      reason: 'policy: target 0xExecutor'
    })
    h.send({ type: 'Halt', reason: 'operator' })
    expect(h.state.lifecycle.kind).toBe('recovering')
    submit(h, liquidation(h, 'while recovering', { conflicts: { writes: ['position:p3'] } }))
    expect(h.notices('while recovering')).toEqual(['refused'])
    expect(h.refusal('while recovering')?.code).toBe('unauthorized')
    expect(h.candidates()).toHaveLength(1)
  })
})
