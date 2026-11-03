import { describe, expect, it } from 'vitest'

import type { Fact, Observation, PlanInput } from '../src'

import { createKernel, latched } from '../src'
import {
  bidOf,
  cancel,
  FEE,
  liquidationPlan,
  makeConfig,
  offer,
  setterPlan,
  tree,
  txHash,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
const FACT = 'liquidatable/p1'

const fact = (h: Harness, version = 'v1'): Fact => ({
  id: FACT,
  version,
  basis: { block: h.block, blockHash: h.hash(h.block) }
})
const seen = (version = 'v1', expiry?: number): Observation => ({
  id: FACT,
  version,
  ...(expiry !== undefined && { expiry })
})

const liquidate = (h: Harness, intentId = 'liq', extra: Partial<PlanInput> = {}) =>
  h.send({ type: 'Submit', plan: liquidationPlan(intentId, extra), observations: [seen()] })

const cancelling = (h: Harness, intentId = 'c', extra: Partial<PlanInput> = {}) =>
  h.send({
    type: 'Submit',
    plan: {
      intentId,
      steps: [{ kind: 'tx', payload: cancel() }],
      notAfter: 1e6,
      basisBlock: 0,
      ...extra
    }
  })

const withFinalOffer = (config = makeConfig()) => {
  const h = new Harness(config).start().liveOffer()
  h.finalize(h.block)
  return h
}

const signsAt = (h: Harness, nonce: number) =>
  h.commands('sign').filter(c => 'nonce' in c && c.nonce === nonce)

const recoveryPlan = (h: Harness, kind: 'fill' | 'neutralizer') =>
  Object.values(h.state.plans).find(p => p.status === 'executing' && p.recovery?.kind === kind)

const answer = (h: Harness, type: 'simulate' | 'sign', intentId: string) => {
  const command = h.pending(type).find(c => c.intentId === intentId)!
  if (type === 'simulate')
    return h.send({
      type: 'Simulated',
      request: command.request,
      ok: true,
      block: h.block,
      blockHash: h.hash(h.block)
    })
  const sign = command as Extract<typeof command, { nonce: number }>
  const hash = txHash(sign.payload, sign.nonce, sign.feeLevel)
  return h.send({
    type: 'Signed',
    request: sign.request,
    hash,
    raw: `raw(${hash})`,
    bid: bidOf(sign)
  })
}

type RebidPhase = 'simulate' | 'await-slot' | 'sign' | 'commit'

/** Moves `intentId`'s re-bid, which is simulating, on to `phase`; another plan holds the slot in `await-slot`. */
const toPhase = (h: Harness, intentId: string, phase: RebidPhase) => {
  if (phase === 'await-slot') {
    liquidate(h, 'other')
    answer(h, 'simulate', 'other')
  }
  if (phase !== 'simulate') answer(h, 'simulate', intentId)
  if (phase === 'commit') answer(h, 'sign', intentId)
  expect(h.state.plans[intentId]?.phase).toBe(phase)
}

/** A step at nonce 0 whose original and one bump are accepted, now stuck again and re-bidding. */
const steppedTwice = () => {
  const h = new Harness().start()
  liquidate(h)
  h.drive()
  h.stall()
  h.drive()
  expect(h.candidates().map(c => [c.feeLevel, c.sent])).toEqual([
    [1, 'accepted'],
    [2, 'accepted']
  ])
  h.stall()
  return { h, plan: 'liq', original: h.candidates()[0]!, bump: h.candidates()[1]! }
}

/** A step whose send and one re-send time out: it is cancelled and its nonce filled. */
const timedOut = (h = new Harness().start()) => {
  liquidate(h)
  h.drive('timeout')
  h.stall()
  h.broadcast('timeout')
  return h
}

/** A recovery fill accepted at the timed-out step's nonce, now stuck and re-bidding. */
const filledOnce = () => {
  const h = timedOut()
  h.drive()
  const fill = h.candidate('0xfill')
  h.stall()
  const plan = recoveryPlan(h, 'fill')!.intentId
  return { h, plan, original: h.candidate('0xexec'), fill }
}

describe('a stuck accepted step is re-bid through its own path', () => {
  it('goes back to ready at the same nonce, one level up, and is checked as its first bid was', () => {
    const h = new Harness().start()
    liquidate(h)
    h.drive()
    h.head()
    h.head()
    expect(h.pending('simulate')).toEqual([])
    h.head()
    expect(h.state.plans.liq?.phase).toBe('simulate')
    h.drive()
    expect(h.candidates().map(c => [c.nonce, c.feeLevel, c.kind])).toEqual([
      [0, 1, 'step'],
      [0, 2, 'step']
    ])
    expect(h.state.plans.liq).toMatchObject({ phase: 'include', terms: { nonce: 0 } })
    expect(h.available('native')).toBe(99n * FEE)
  })

  it('simulates afresh even while its last simulation is recent', () => {
    const h = new Harness(makeConfig({ maxSimLagBlocks: 50 })).start()
    liquidate(h)
    h.drive()
    h.stall()
    expect(h.pending('simulate')).toHaveLength(1)
    h.simulate(false)
    expect(signsAt(h, 0)).toHaveLength(1)
    expect(h.lastReason('liq')).toBe('simulation failed')
    const [original] = h.candidates()
    h.head()
    h.mine(original!.hash, { status: 'reverted' })
    for (let i = 0; i < 4; i++) h.head()
    const last = h
      .commands('notify')
      .filter(c => c.intentId === 'liq')
      .at(-1)
    expect(last).toMatchObject({ notice: 'compensated' })
    expect(last).not.toHaveProperty('code')
  })

  it('is refused for evidence that changed since its first bid, as a first bid is', () => {
    const h = new Harness().start()
    liquidate(h, 'liq', { evidence: [fact(h)] })
    h.drive()
    h.send({ type: 'Observed', observations: [seen('v2')] })
    h.stall()
    h.drive()
    expect(signsAt(h, 0)).toHaveLength(1)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
    expect(h.lastReason('liq')).toBe(`evidence ${FACT} changed`)
  })

  it('is not re-bid past its deadline, even when nothing cancels it first', () => {
    const h = withFinalOffer()
    cancelling(h, 'c', { notAfter: 10_000 })
    h.drive()
    h.tick(10_000)
    h.stall()
    expect(signsAt(h, h.candidate('0xsetConsumed').nonce)).toHaveLength(1)
  })

  it('cannot be superseded while it bids at its nonce', () => {
    const h = new Harness().start()
    liquidate(h)
    h.drive()
    h.stall()
    expect(h.state.plans.liq?.phase).toBe('simulate')
    h.send({ type: 'Submit', plan: liquidationPlan('next', { supersedes: 'liq' }) })
    expect(h.refusal('next')?.code).toBe('supersession')
  })

  it('is cancelled by a stop while it bids, but left to settle while it waits in include', () => {
    const rebidding = new Harness().start()
    liquidate(rebidding)
    rebidding.drive()
    rebidding.stall()
    rebidding.send({ type: 'Stop' })
    expect(rebidding.notices('liq')).toEqual(['admitted', 'compensating'])

    const waiting = new Harness().start()
    liquidate(waiting)
    waiting.drive()
    waiting.send({ type: 'Stop' })
    expect(waiting.state.plans.liq).toMatchObject({ status: 'executing', phase: 'include' })
  })

  it('a cancellation, which may run while latched, is not re-bid while another nonce latches the kernel', () => {
    const h = withFinalOffer()
    cancelling(h)
    h.drive()
    const { nonce } = h.candidate('0xsetConsumed')
    liquidate(h, 'other')
    h.drive('timeout')
    expect(latched(h.state)).toBe(true)
    h.stall()
    h.simulate()
    h.sign()
    expect(signsAt(h, nonce)).toHaveLength(1)
    expect(h.state.plans.c?.phase).toBe('include')
  })

  it('a creator re-bid wins and creates its commitment', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    h.stall()
    h.drive()
    const [, again] = h.state.nonces[0]!.candidates
    h.head()
    h.mine(again!.hash)
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.state.plans.q).toMatchObject({ cursor: 1, phase: 'awaiting-advance' })
  })
})

describe('a nonce resolving settles its plan by the winner, whatever the re-bid is doing', () => {
  const phases: RebidPhase[] = ['simulate', 'await-slot', 'sign', 'commit']
  const cases = phases.flatMap(phase =>
    (['original', 'bump', 'fill'] as const).flatMap(winner =>
      (['head', 'final'] as const).map(at => [phase, winner, at] as const)
    )
  )

  it.each(cases)('while it is in %s, the %s winning at a %s block', (phase, winner, at) => {
    const setup = winner === 'fill' ? filledOnce() : steppedTwice()
    const { h, plan } = setup
    toPhase(h, plan, phase)
    const before = h.log.length
    const sign = h.pending('sign').find(c => c.intentId === plan)
    const hash =
      winner === 'original'
        ? setup.original.hash
        : winner === 'bump'
          ? (setup as ReturnType<typeof steppedTwice>).bump.hash
          : (setup as ReturnType<typeof filledOnce>).fill.hash
    h.head()
    h.mine(hash, { block: at === 'final' ? h.state.finalized.number : h.block })

    if (sign) expect(createKernel(h.config).signRefusal(h.state, sign.request, h.now)).toBeDefined()
    expect(Object.values(h.state.outstanding).filter(o => o.plan === plan)).toEqual([])
    if (at === 'final') expect(h.state.nonces[0]).toBeUndefined()
    if (phase === 'commit' && at === 'head')
      expect(h.candidates().filter(c => c.feeLevel === 3)).toMatchObject([{ sent: 'withheld' }])
    if (winner === 'fill')
      expect(h.state.plans[plan]?.status).toBe(at === 'head' ? 'settled' : undefined)
    else expect(h.notices(plan)).toEqual(['admitted', 'settled'])
    const settled = h.commands('notify').find(c => c.intentId === plan && c.notice === 'settled')
    if (winner !== 'fill')
      expect(settled?.included).toEqual([
        { step: 0, hash, block: expect.any(Number), success: true }
      ])

    h.drive()
    const signedAfter = h.log
      .slice(before)
      .filter(c => c.type === 'sign' && 'nonce' in c && c.nonce === 0)
    expect(signedAfter).toEqual([])
    h.finalize(h.block)
    expect(h.state.nonces[0]).toBeUndefined()
  })

  it('withholds at hand-off the bytes of a recovery bid whose nonce resolved', () => {
    const { h, plan, original } = filledOnce()
    toPhase(h, plan, 'commit')
    h.flush()
    const [send] = h.pending('broadcast')
    h.head()
    h.mine(original.hash)
    expect(createKernel(h.config).withholds(h.state, plan, h.now, send!.hash)).toBe(
      'its nonce resolved'
    )
  })

  it('a fill re-bid at the nonce its step took settles nothing of its own, and the step reads its winner', () => {
    const { h, plan, original } = filledOnce()
    toPhase(h, plan, 'sign')
    h.head()
    h.mine(original.hash)
    expect(h.state.plans[plan]).toMatchObject({ status: 'failed', reason: 'step did not execute' })
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
  })
})

describe('the step cap', () => {
  /** Signs each re-bid up to `cap` levels and answers anything above it with the cap. */
  const bidUpTo = (h: Harness, cap: number) => {
    for (let round = 0; round < 8; round++) {
      h.simulate()
      for (const command of h.pending('sign')) {
        if ('nonce' in command && command.feeLevel > cap)
          h.send({ type: 'StepCapReached', request: command.request })
      }
      h.drive()
      h.stall()
    }
  }

  it('stops bumping at the ceiling with no count of bids, and waits beside its candidates', () => {
    const h = new Harness().start()
    liquidate(h, 'liq', { notAfter: 1e6 })
    h.drive()
    h.stall()
    bidUpTo(h, 3)
    expect(h.candidates().map(c => c.feeLevel)).toEqual([1, 2, 3])
    expect(signsAt(h, 0)).toHaveLength(4)
    expect(h.state.plans.liq).toMatchObject({ phase: 'include', terms: { capped: true } })
    expect(h.state.slot).toBeUndefined()
    for (let i = 0; i < 5; i++) h.stall()
    expect(signsAt(h, 0)).toHaveLength(4)
    h.tick(1e6)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
  })
})

describe('one deadline, in every phase', () => {
  it('cancels a step waiting in include before its nonce is stuck, and its nonce is filled', () => {
    const h = new Harness().start()
    liquidate(h, 'liq', { notAfter: 10_000 })
    h.drive()
    h.tick(10_000)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
    expect(h.lastReason('liq')).toBe('intent expired')
    h.stall()
    h.drive()
    expect(h.candidate('0xfill')).toMatchObject({ nonce: 0, feeLevel: 2 })
  })

  it('withholds a cancellation committed before its deadline whose flush lands after it', () => {
    const h = withFinalOffer()
    cancelling(h, 'c', { notAfter: 10_000 })
    h.simulate()
    h.sign()
    expect(h.state.plans.c?.phase).toBe('commit')
    expect(createKernel(h.config).withholds(h.state, 'c', 10_000)).toBe('intent expired')
    h.tick(10_000)
    h.flush()
    h.broadcast()
    expect(h.candidate('0xsetConsumed').sent).toBe('withheld')
    expect(h.broadcastsTo('setConsumed')).toEqual([])
    expect(h.notices('c')).toEqual(['admitted', 'compensating'])
    expect(h.lastReason('c')).toBe('intent expired')
  })

  it('cancels a cancellation whose send waits at hand-off past its deadline, keeping the send to answer', () => {
    const h = withFinalOffer()
    cancelling(h, 'c', { notAfter: 10_000 })
    h.simulate()
    h.sign()
    h.flush()
    const [send] = h.pending('broadcast')
    h.tick(10_000)
    expect(h.state.plans.c?.status).toBe('compensating')
    expect(h.state.outstanding[send!.request]).toMatchObject({ kind: 'broadcast' })
    expect(createKernel(h.config).withholds(h.state, 'c', h.now, send!.hash)).toBe(
      'plan compensating'
    )
    h.send({ type: 'Broadcasted', request: send!.request, hash: send!.hash, outcome: 'withheld' })
    expect(h.candidate('0xsetConsumed').sent).toBe('withheld')
    expect(h.state.slot).toBeUndefined()
    expect(h.notices('c')).toEqual(['admitted', 'compensating'])
  })

  it('an observation once the deadline has passed never extends it', () => {
    const h = new Harness().start()
    liquidate(h, 'liq', { evidence: [fact(h)] })
    h.drive()
    h.tick(1_000)
    h.send({ type: 'Observed', observations: [seen('v1', 500)] })
    expect(h.state.plans.liq?.notAfter).toBe(500)
    h.send({ type: 'Observed', observations: [seen('v1', 1e6)] })
    expect(h.state.plans.liq?.notAfter).toBe(500)
    h.tick(0)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
  })

  it('a refreshed observation never extends the deadline past what the decision is valid until', () => {
    const h = new Harness().start()
    liquidate(h, 'liq', { evidence: [fact(h)], notAfter: 200, validUntil: 200 })
    h.drive()
    expect(h.state.plans.liq?.notAfter).toBe(200)
    h.send({ type: 'Observed', observations: [seen('v1', 1e6)] })
    expect(h.state.plans.liq?.notAfter).toBe(200)
    h.tick(200)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
  })
})

describe('a step bids only after its earlier transactions executed', () => {
  /** A risk-reducing plan, so no stage boundary parks it: cancel, then a neutral call. */
  const twoSteps = (h: Harness) =>
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'two',
        steps: [{ kind: 'tx', payload: cancel() }, liquidationPlan('x').steps[0]!],
        notAfter: 10_000,
        basisBlock: 0
      }
    })

  const firstIncluded = () => {
    const h = withFinalOffer()
    twoSteps(h)
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(h.state.plans.two).toMatchObject({ cursor: 1, phase: 'simulate' })
    return h
  }

  it.each([
    ['original', 'head'],
    ['original', 'final'],
    ['bump', 'head'],
    ['bump', 'final']
  ] as const)(
    'a re-bid waiting in ready on its predecessor is settled once when its %s wins at a %s block',
    (winner, at) => {
      const h = firstIncluded()
      h.finalizedLag = 20
      const includedAt = h.block
      h.drive()
      h.stall()
      if (winner === 'bump') {
        h.drive()
        h.stall()
      }
      expect(h.state.plans.two?.phase).toBe('simulate')
      h.reorg(includedAt - 1)
      h.drive()
      expect(h.state.plans.two?.phase).toBe('ready')
      h.stall()
      h.drive()
      const fill = h.candidate('0xfill')
      const step = h.candidates().filter(c => c.hash.startsWith('0xexec'))[
        winner === 'bump' ? 1 : 0
      ]!
      h.head()
      h.mine(fill.hash)
      h.mine(step.hash, { block: at === 'final' ? h.state.finalized.number : h.block })
      const settled = h
        .commands('notify')
        .filter(c => c.intentId === 'two' && c.notice === 'settled')
      expect(h.notices('two')).toEqual(['admitted', 'settled'])
      expect(settled[0]?.included).toEqual([
        { step: 1, hash: step.hash, block: expect.any(Number), success: true }
      ])
      expect(Object.values(h.state.outstanding).filter(o => o.plan === 'two')).toEqual([])
      h.drive()
      h.finalize(h.block)
      expect(h.state.nonces).toEqual({})
      expect(h.notices('two')).toEqual(['admitted', 'settled'])
    }
  )

  it('waits while a reorg undoes its predecessor, and bids once it lands again', () => {
    const h = firstIncluded()
    const first = h.candidate('0xsetConsumed')
    h.reorg(h.block - 1)
    h.simulate()
    expect(h.state.plans.two?.phase).toBe('ready')
    expect(signsAt(h, first.nonce + 1)).toEqual([])
    h.head()
    h.mine(first.hash)
    h.drive()
    expect(h.candidate('0xexec')).toMatchObject({ nonce: first.nonce + 1 })
  })

  it('waits on a predecessor a reorg reverted, keeping its record, and is cancelled at its deadline', () => {
    const h = firstIncluded()
    const first = h.candidate('0xsetConsumed')
    h.reorg(h.block - 1)
    h.simulate()
    h.head()
    h.mine(first.hash, { status: 'reverted' })
    h.finalize(h.block)
    expect(h.state.nonces[first.nonce]).toBeDefined()
    expect(h.state.plans.two?.phase).toBe('ready')
    h.tick(10_000)
    expect(h.notices('two')).toEqual(['admitted', 'compensating', 'compensated'])
    expect(h.state.nonces[first.nonce]).toBeUndefined()
  })

  it('reads its predecessor from its inclusions once that record is pruned', () => {
    const h = firstIncluded()
    h.finalize(h.block)
    expect(Object.keys(h.state.nonces)).toEqual([])
    h.drive()
    h.stall()
    h.drive()
    expect(h.candidates().map(c => [c.hash.split(':')[0], c.feeLevel])).toEqual([
      ['0xexec', 1],
      ['0xexec', 2]
    ])
  })
})

describe('an uncertain nonce is re-sent once, then bid over by recovery', () => {
  it('re-sends a timed-out step once, never while that re-send is out, then cancels it for a fill', () => {
    const h = new Harness().start()
    liquidate(h)
    h.drive('timeout')
    const exec = h.candidate('0xexec')
    h.stall()
    expect(h.commands('broadcast').filter(c => c.hash === exec.hash)).toHaveLength(2)
    h.stall()
    h.stall()
    expect(h.commands('broadcast').filter(c => c.hash === exec.hash)).toHaveLength(2)
    expect(h.state.plans.liq?.phase).toBe('include')
    h.broadcast('timeout')
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
    expect(h.lastReason('liq')).toBe('its nonce stayed uncertain after a re-send')
    h.drive()
    expect(h.candidate('0xfill')).toMatchObject({ nonce: 0, feeLevel: 2, sent: 'accepted' })
    h.stall()
    expect(h.commands('broadcast').filter(c => c.hash === exec.hash)).toHaveLength(2)
  })

  it('re-sends again once in a new process', () => {
    const h = timedOut()
    h.drive('timeout')
    const fill = h.candidate('0xfill')
    h.stall()
    h.broadcast('timeout')
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0)
    for (let i = 0; i < 3; i++) h.stall()
    expect(h.commands('broadcast').filter(c => c.hash === fill.hash)).toHaveLength(1)
  })

  it('a covered unknown neither latches nor escalates past the latch bound', () => {
    const h = timedOut()
    h.drive()
    expect(h.candidates().map(c => c.sent)).toEqual(['unknown', 'accepted'])
    expect(latched(h.state)).toBe(false)
    for (let i = 0; i <= h.config.latchBoundBlocks; i++) h.head()
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('an unknown recovery neutralizer the re-send does not resolve continues as a neutralizer', () => {
    const h = withFinalOffer()
    h.send({ type: 'Stop' })
    h.simulate()
    h.sign()
    h.flush()
    h.broadcast('unknown')
    const first = h.candidate('0xsetConsumed')
    const attempts = h.entry(G1)?.recoveryAttempts
    h.stall()
    h.broadcast('timeout')
    h.drive()
    const cancels = h.candidates().filter(c => c.nonce === first.nonce)
    expect(cancels.map(c => [c.kind, c.retires])).toEqual([
      ['neutralizer', [G1]],
      ['neutralizer', [G1]]
    ])
    expect(h.entry(G1)).toMatchObject({ state: 'revoking', recoveryAttempts: attempts })
  })
})

describe('a recovery bid rejected at its own nonce', () => {
  /** An offer whose affirmation lapses, so recovery cancels it at a fresh nonce, and the node rejects that. */
  const rejectedNeutralizer = () => {
    const h = withFinalOffer()
    h.tick(h.config.revokeAfterStaleMs + 1)
    h.simulate()
    h.sign()
    h.flush()
    h.broadcast('rejected')
    return { h, first: h.candidate('0xsetConsumed') }
  }

  it('bids again at that nonce, and the later bid retires the entry', () => {
    const { h, first } = rejectedNeutralizer()
    h.drive()
    expect(h.pending('simulate')).toEqual([])
    h.stall()
    h.drive()
    const cancels = h.candidates().filter(c => c.nonce === first.nonce)
    expect(cancels.map(c => [c.kind, c.feeLevel, c.sent])).toEqual([
      ['neutralizer', 1, 'rejected'],
      ['neutralizer', 2, 'accepted']
    ])
    expect(h.candidates().filter(c => c.kind === 'fill')).toEqual([])
    h.head()
    h.mine(cancels[1]!.hash)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('waits at the ceiling, re-sending the bytes it signed until they land', () => {
    const { h, first } = rejectedNeutralizer()
    h.stall()
    h.simulate()
    const [capped] = h.pending('sign')
    h.send({ type: 'FeeCeilingReached', request: capped!.request })
    expect(h.alarms()).toContain(`nonce ${first.nonce} waits at the fee ceiling`)
    h.stall()
    expect(h.pending('broadcast').map(c => c.hash)).toEqual([first.hash])
    h.broadcast()
    h.stall()
    expect(h.state.lifecycle.kind).toBe('running')
    h.head()
    h.mine(first.hash)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
  })
})

describe('send status and uncertainty age', () => {
  it('never demotes an accepted candidate while running', () => {
    const h = new Harness().start()
    liquidate(h)
    h.drive()
    const { hash } = h.candidate('0xexec')
    h.send({ type: 'Broadcasted', hash, outcome: 'unknown' })
    h.send({ type: 'Broadcasted', hash, outcome: 'rejected' })
    expect(h.candidate('0xexec').sent).toBe('accepted')
    expect(latched(h.state)).toBe(false)
  })

  it('never demotes a candidate accepted while its send is still out, when that send times out', () => {
    const h = new Harness().start()
    liquidate(h)
    h.simulate()
    h.sign()
    h.flush()
    const [send] = h.pending('broadcast')
    h.send({ type: 'Broadcasted', hash: send!.hash, outcome: 'accepted' })
    h.send({ type: 'TimedOut', request: send!.request })
    expect(h.candidate('0xexec').sent).toBe('accepted')
    expect(latched(h.state)).toBe(false)
  })

  it('a crash before the broadcast counts the stuck threshold from its commit head', () => {
    const h = new Harness().start()
    liquidate(h)
    h.simulate()
    h.sign()
    h.head()
    h.flush({ ack: false })
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0)
    expect(h.candidate('0xexec')).toMatchObject({ sent: 'unknown', sendHead: 1 })
    expect(recoveryPlan(h, 'fill')).toBeUndefined()
    h.head()
    expect(recoveryPlan(h, 'fill')).toBeDefined()
  })

  it('a nonce uncertain once long ago still runs after a restart 200 blocks later', () => {
    const h = new Harness().start()
    liquidate(h)
    h.drive('timeout')
    h.stall()
    h.broadcast('accepted')
    h.flush()
    expect(h.candidate('0xexec')).not.toHaveProperty('unknownSince')
    h.crash()
    h.head(h.block + 200)
    h.boot()
    h.head()
    h.nonceAt(0)
    h.head()
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('a restart keeps no age for an unknown a higher accepted bid covered, and re-accepts the bytes', () => {
    const h = timedOut()
    h.drive()
    h.flush()
    expect(h.ledger()!.nonces[0]!.candidates.map(c => [c.sent, c.unknownSince])).toEqual([
      ['unknown', expect.any(Number)],
      ['accepted', undefined]
    ])
    h.crash()
    h.head(h.block + 200)
    h.boot()
    h.head()
    h.nonceAt(0)
    expect(h.state.lifecycle.kind).toBe('running')
    h.stall()
    h.broadcast('accepted')
    expect(h.candidate('0xfill').sent).toBe('accepted')
    expect(latched(h.state)).toBe(false)
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('a nonce genuinely uncertain at a crash escalates at the first head 200 blocks later', () => {
    const h = new Harness().start()
    liquidate(h)
    h.drive('timeout')
    h.flush()
    expect(h.ledger()!.nonces[0]?.candidates[0]?.unknownSince).toBe(1)
    h.crash()
    h.head(h.block + 200)
    h.boot()
    h.head()
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'latch bound exceeded' })
  })
})

describe('reservations across steps', () => {
  it('a step included but not final holds the next step its own reserve, and the next bid takes a new nonce', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    expect(h.available('native')).toBe(98n * FEE)
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    expect(h.state.plans.q).toMatchObject({ cursor: 1, phase: 'awaiting-advance' })
    expect(h.state.plans.q?.terms).toBeUndefined()
    expect(h.available('native')).toBe(99n * FEE)
    h.advance('q')
    h.drive()
    expect(h.candidate('0xpublish').nonce).toBe(1)
  })
})
