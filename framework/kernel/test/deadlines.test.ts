import { describe, expect, it } from 'vitest'

import type { Fact, Observation, PlanInput } from '../src'

import { ABSENT, createKernel } from '../src'
import { encodeCall } from './codec'
import {
  ecrecoverPlan,
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

const FACT = 'liquidatable/p1'
const OTHER = 'liquidatable/p2'

const fact = (h: Harness, version = 'v1', id = FACT): Fact => ({
  id,
  version,
  basis: { block: h.block, blockHash: h.hash(h.block) }
})

const seen = (expiry?: number, version = 'v1', id = FACT): Observation => ({
  id,
  version,
  ...(expiry !== undefined && { expiry })
})

const liquidation = (h: Harness, intentId: string, extra: Partial<PlanInput> = {}): PlanInput =>
  liquidationPlan(intentId, { evidence: [fact(h)], ...extra })

const submit = (h: Harness, plan: PlanInput, observations: Observation[] = [seen()]) =>
  h.send({ type: 'Submit', plan, observations })

const observed = (h: Harness, ...observations: Observation[]) =>
  h.send({ type: 'Observed', observations })

const twoTransfers: PlanInput = {
  intentId: 'x',
  steps: [
    { kind: 'tx', payload: transfer(10n, 'a') },
    { kind: 'tx', payload: transfer(10n, 'b') }
  ],
  notAfter: 1_000_000,
  basisBlock: 0
}

const deadline = (h: Harness, intentId: string) => h.state.plans[intentId]?.notAfter

/** Submits `plan`, then simulates it, leaving the signer's request for the guard to judge. */
const awaitingSigner = (h: Harness, plan: PlanInput, observations?: Observation[]) => {
  submit(h, plan, observations)
  h.simulate()
  const [sign] = h.pending('sign')
  return sign!.request
}

describe('the deadline a plan starts with', () => {
  it.each([
    ['its own notAfter when that comes first', 2_000, 3_000, 2_000],
    ['the expiry seeded with it when that comes first', 5_000, 3_000, 3_000],
    ['the seeded expiry when it names no notAfter', undefined, 3_000, 3_000],
    ['its own notAfter when no expiry is seeded', 2_000, undefined, 2_000]
  ] as const)('is %s', (_name, notAfter, expiry, expected) => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', notAfter === undefined ? {} : { notAfter }), [seen(expiry)])
    expect(deadline(h, 'liq')).toBe(expected)
  })

  it('refuses a plan whose seeded expiry has already passed', () => {
    const h = new Harness().start()
    h.tick(1_000)
    submit(h, liquidation(h, 'liq'), [seen(1_000)])
    expect(h.refusal('liq')).toEqual({ code: 'evidence_expired', reason: 'evidence expired' })
    expect(h.notices('liq')).toEqual(['refused'])
  })

  it('refuses an act resting on an absent fact once that absence expires', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    const request = awaitingSigner(h, liquidation(h, 'liq', { evidence: [fact(h, ABSENT)] }), [
      seen(1_000, ABSENT)
    ])
    expect(kernel.signRefusal(h.state, request, h.now)).toBeUndefined()
    expect(kernel.signRefusal(h.state, request, 1_000)).toBe('evidence expired')
    h.tick(1_000)
    expect(h.lastReason('liq')).toBe('evidence expired')
    h.sign()
    expect(h.candidates()).toEqual([])
  })

  it('an intent submitted past its deadline is never signed', () => {
    const h = new Harness().start()
    h.tick(1_000)
    h.send({ type: 'Submit', plan: liquidationPlan('liq', { notAfter: 500 }) })
    h.drive()
    expect(h.refusal('liq')).toEqual({ code: 'evidence_expired', reason: 'evidence expired' })
    expect(h.commands('simulate')).toHaveLength(0)
    expect(h.commands('sign')).toHaveLength(0)
    expect(h.commands('broadcast')).toHaveLength(0)
  })
})

describe('a deadline after admission', () => {
  it('falls to an expiry that appears on an unchanged fact, and the act is refused at it', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    const request = awaitingSigner(h, liquidation(h, 'liq', { notAfter: 10_000 }))
    observed(h, seen(1_000))
    expect(deadline(h, 'liq')).toBe(1_000)
    h.tick(999)
    expect(kernel.signRefusal(h.state, request, h.now)).toBeUndefined()
    expect(kernel.signRefusal(h.state, request, h.now + 1)).toBe('evidence expired')
  })

  it('never rises within a stage, whether the expiry is extended or removed', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', { notAfter: 10_000 }), [seen(5_000)])
    observed(h, seen(1_000))
    observed(h, seen(4_000))
    expect(deadline(h, 'liq')).toBe(1_000)
    observed(h, seen())
    expect(deadline(h, 'liq')).toBe(1_000)
    expect(h.state.observations[FACT]).toStrictEqual({ id: FACT, version: 'v1' })
  })

  it('falls for every executing plan a later submission seeds the same fact for', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'first', { notAfter: 10_000 }))
    submit(h, liquidation(h, 'second'), [seen(500)])
    expect(deadline(h, 'first')).toBe(500)
    expect(deadline(h, 'second')).toBe(500)
  })

  it('falls for a plan resting on an absent fact when that absence gains an expiry', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', { evidence: [fact(h, ABSENT)], notAfter: 10_000 }), [
      seen(undefined, ABSENT)
    ])
    expect(deadline(h, 'liq')).toBe(10_000)
    observed(h, seen(800, ABSENT))
    expect(deadline(h, 'liq')).toBe(800)
  })

  it('stays put when an unrelated fact expires', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', { notAfter: 10_000 }))
    submit(h, liquidation(h, 'other', { evidence: [fact(h, 'v1', OTHER)], notAfter: 10_000 }), [
      seen(undefined, 'v1', OTHER)
    ])
    observed(h, seen(100, 'v1', OTHER))
    expect(deadline(h, 'liq')).toBe(10_000)
    expect(deadline(h, 'other')).toBe(100)
  })

  it.each([
    ['not a number', Number.NaN],
    ['negative', -1],
    ['fractional', 1.5],
    ['unbounded', Number.POSITIVE_INFINITY],
    ['beyond a safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '100']
  ])('reads a fact as failed, and keeps its deadline, when its expiry is %s', (_name, expiry) => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    const request = awaitingSigner(h, liquidation(h, 'liq', { notAfter: 10_000 }))
    observed(h, { id: FACT, version: 'v1', expiry } as Observation)
    expect(h.alarms()).toContain('malformed observation expiry')
    expect(h.state.observations[FACT]).toStrictEqual({ id: FACT, unavailable: 'failed' })
    expect(deadline(h, 'liq')).toBe(10_000)
    expect(kernel.signRefusal(h.state, request, h.now)).toBe(`evidence ${FACT} failed`)
  })

  it('refuses a submission whose seed carries a malformed expiry', () => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq'), [{ id: FACT, version: 'v1', expiry: Number.NaN }])
    expect(h.lastReason('liq')).toBe(`evidence ${FACT} failed`)
  })
})

describe('a shortened deadline at the signer and handoff guards', () => {
  const increasing = (h: Harness): PlanInput => ({
    ...liquidation(h, 'act', { notAfter: 10_000 }),
    steps: [{ kind: 'tx', payload: transfer(100n, 'act') }]
  })

  it.each([
    ['neutral', (h: Harness) => liquidation(h, 'act', { notAfter: 10_000 }), 'sent'],
    ['risk-increasing', increasing, 'withheld: evidence expired']
  ] as const)(
    'a %s act whose deadline falls and passes after commit is %s',
    (_kind, plan, outcome) => {
      const h = new Harness().start()
      const kernel = createKernel(h.config)
      submit(h, plan(h))
      h.simulate()
      h.sign()
      expect(h.state.plans.act?.phase).toBe('commit')
      observed(h, seen(1_000))
      h.tick(1_000)
      const withheld = kernel.withholds(h.state, 'act', h.now)
      h.flush()
      h.broadcast()
      const [candidate] = h.candidates()
      if (outcome === 'sent') {
        expect(withheld).toBeUndefined()
        expect(candidate).toMatchObject({ sent: 'accepted' })
      } else {
        expect(withheld).toBe('evidence expired')
        expect(candidate).toMatchObject({ sent: 'withheld' })
        expect(h.lastReason('act')).toBe(outcome)
      }
    }
  )

  it('refuses a risk-increasing act at the signer once its deadline falls and passes', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    const request = awaitingSigner(h, increasing(h))
    observed(h, seen(1_000))
    expect(kernel.signRefusal(h.state, request, h.now)).toBeUndefined()
    expect(kernel.signRefusal(h.state, request, 1_000)).toBe('evidence expired')
  })

  /** `act` as the kernel's own recovery would hold it: recovery plans carry no evidence of their own. */
  const asRecovery = (h: Harness) => ({
    ...h.state,
    plans: {
      ...h.state.plans,
      act: { ...h.state.plans.act!, recovery: { kind: 'neutralizer' as const } }
    }
  })

  it('never refuses a recovery plan at the signer for a deadline its evidence fell to', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    const request = awaitingSigner(h, liquidation(h, 'act', { notAfter: 10_000 }))
    observed(h, seen(1_000))
    expect(kernel.signRefusal(h.state, request, 1_000)).toBe('evidence expired')
    expect(kernel.signRefusal(asRecovery(h), request, 1_000)).toBe(
      'policy now refuses: policy: target 0xExecutor'
    )
  })

  it('never withholds a recovery plan at handoff for a deadline its evidence fell to', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    submit(h, increasing(h))
    h.simulate()
    h.sign()
    expect(h.state.plans.act?.phase).toBe('commit')
    observed(h, seen(1_000))
    h.tick(1_000)
    expect(kernel.withholds(h.state, 'act', h.now)).toBe('evidence expired')
    expect(kernel.withholds(asRecovery(h), 'act', h.now)).toBeUndefined()
  })

  it('ends a risk-reducing plan at the deadline its evidence fell to', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.entry(midnightId('g1'))?.state).toBe('live')
    const pull: PlanInput = {
      intentId: 'pull',
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
      evidence: [fact(h)]
    }
    const kernel = createKernel(h.config)
    const request = awaitingSigner(h, pull, [seen(1_000)])
    expect(h.notices('pull')).toEqual(['admitted'])
    observed(h, seen(500))
    expect(deadline(h, 'pull')).toBe(500)
    expect(kernel.signRefusal(h.state, request, 500)).toBe('evidence expired')
    h.tick(500)
    expect(h.lastReason('pull')).toBe('evidence expired')
    h.drive()
    expect(h.candidates().filter(c => c.intentId === 'pull')).toEqual([])
  })
})

describe('a deadline after an unknown send', () => {
  it.each([
    ['rebroadcasts it before the deadline its evidence fell to', 499, 2],
    ['stops rebroadcasting it at that deadline', 500, 1]
  ])('%s', (_name, now, broadcasts) => {
    const h = new Harness().start()
    submit(h, liquidation(h, 'liq', { notAfter: 10_000 }))
    h.drive('timeout')
    observed(h, seen(500))
    h.tick(now)
    for (let i = 0; i < 4; i++) h.head()
    expect(h.broadcastsTo('exec')).toHaveLength(broadcasts)
  })
})

describe('a deadline while a send is being included', () => {
  /** An unknown send resting on two facts, its deadline 1000. */
  const included = () => {
    const h = new Harness().start()
    submit(
      h,
      liquidation(h, 'liq', { evidence: [fact(h), fact(h, 'v1', OTHER)], notAfter: 1_000 }),
      [seen(), seen(5_000, 'v1', OTHER)]
    )
    h.drive('timeout')
    expect(h.state.plans.liq?.phase).toBe('include')
    return h
  }
  const rebroadcastsAt = (h: Harness, now: number) => {
    h.tick(now - h.now)
    for (let i = 0; i < 4; i++) h.head()
    return h.broadcastsTo('exec').length
  }

  it('follows its facts read again unchanged, and rebroadcasts while they hold', () => {
    const h = included()
    observed(h, seen(10_000), seen(10_000, 'v1', OTHER))
    expect(deadline(h, 'liq')).toBe(10_000)
    expect(rebroadcastsAt(h, 1_500)).toBeGreaterThan(1)
  })

  it.each([
    ['before', [seen(10_000), { id: OTHER, unavailable: 'failed' } as Observation]],
    ['after', [{ id: OTHER, unavailable: 'failed' } as Observation, seen(10_000)]],
    ['beside a changed one', [seen(10_000), seen(10_000, 'v2', OTHER)]],
    [
      'of a fact the same batch also read as failed',
      [{ id: FACT, unavailable: 'failed' } as Observation, seen(10_000), seen(10_000, 'v1', OTHER)]
    ]
  ])('is never extended by an equal read %s one that no longer holds', (_order, batch) => {
    const h = included()
    observed(h, ...batch)
    expect(deadline(h, 'liq')).toBe(1_000)
    expect(rebroadcastsAt(h, 1_500)).toBe(1)
  })
})

describe('the deadline of a stage', () => {
  const BOOK = 'quoter:book'
  const T = tree(offer('g1', 300n, { ratifier: W.setter }))

  /** Ratify then publish, its first stage clamped to `expiry`, parked once ratification is mined. */
  const parked = (expiry: number) => {
    const h = new Harness().start()
    submit(
      h,
      {
        ...setterPlan('q', T),
        basisBlock: h.block,
        evidence: [fact(h)],
        conflicts: { writes: [BOOK] }
      },
      [seen(expiry)]
    )
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    return h
  }

  it('ends a parked plan whose finished stage deadline an observation lowered past, on its next advance', () => {
    const h = parked(10_000)
    h.tick(5_000)
    observed(h, seen(4_000))
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    h.advance('q', { evidence: [fact(h)], notAfter: 20_000, observations: [seen(20_000)] })
    expect(h.notices('q').at(-1)).toBe('compensating')
    expect(h.lastReason('q')).toBe('evidence expired')
  })

  it('starts from its own seeded expiry, and an earlier stage deadline never leaks into it', () => {
    const h = parked(1_000)
    observed(h, seen(500))
    expect(deadline(h, 'q')).toBe(500)
    h.tick(400)
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    h.advance('q', { evidence: [fact(h)], notAfter: 9_000, observations: [seen(5_000)] })
    expect(h.notices('q').at(-1)).toBe('advanced')
    expect(deadline(h, 'q')).toBe(5_000)
  })

  it('stalls an advance whose seeded expiry has already passed, and leaves the plan parked', () => {
    const h = parked(10_000)
    h.tick(2_000)
    h.advance('q', { evidence: [fact(h)], observations: [seen(2_000)] })
    expect(h.notices('q').at(-1)).toBe('stalled')
    expect(h.lastReason('q')).toBe('evidence expired')
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
  })

  it('lowers the deadline of another executing plan resting on the fact its advance seeds', () => {
    const h = parked(10_000)
    submit(h, liquidation(h, 'liq', { notAfter: 20_000 }))
    expect(deadline(h, 'liq')).toBe(20_000)
    h.advance('q', { evidence: [fact(h)], observations: [seen(4_000)] })
    expect(h.notices('q').at(-1)).toBe('advanced')
    expect(deadline(h, 'liq')).toBe(4_000)
    expect(deadline(h, 'q')).toBe(4_000)
  })

  it('leaves a new stage resting on other evidence untouched when the old stage fact expires', () => {
    const h = parked(10_000)
    h.advance('q', {
      evidence: [fact(h, 'v1', OTHER)],
      notAfter: 9_000,
      observations: [seen(undefined, 'v1', OTHER)]
    })
    expect(h.notices('q').at(-1)).toBe('advanced')
    observed(h, seen(500))
    expect(deadline(h, 'q')).toBe(9_000)
  })

  it('stalls an advance that names no deadline, and leaves the plan parked', () => {
    const h = parked(10_000)
    h.advance('q', { evidence: [fact(h)], notAfter: undefined, observations: [seen()] } as never)
    expect(h.notices('q').at(-1)).toBe('stalled')
    expect(h.lastReason('q')).toBe('basis block and expiry must be non-negative safe integers')
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
  })

  it('falls within the new stage like any other', () => {
    const h = parked(10_000)
    h.advance('q', { evidence: [fact(h)], notAfter: 9_000, observations: [seen()] })
    expect(deadline(h, 'q')).toBe(9_000)
    observed(h, seen(3_000))
    expect(deadline(h, 'q')).toBe(3_000)
  })

  it('a stage advanced onto a deadline already past is never signed', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: twoTransfers })
    h.drive()
    h.head()
    h.mine(h.candidate('0xtransfer:a').hash)
    h.tick(1_000)
    h.advance('x', { notAfter: 500 })
    expect(h.lastReason('x')).toBe('intent expired')
    expect(h.state.plans.x?.phase).toBe('awaiting-advance')
    expect(h.commands('sign')).toHaveLength(1)
  })
})

describe('a plan with no deadline', () => {
  it('is refused at admission as malformed', () => {
    const h = new Harness().start()
    const { notAfter: _, ...unbounded } = liquidation(h, 'unbounded')
    submit(h, unbounded as PlanInput)
    expect(h.refusal('unbounded')).toEqual({
      code: 'malformed',
      reason: 'basis block and expiry must be non-negative safe integers'
    })
    expect(h.state.plans.unbounded).toBeUndefined()
  })
})

describe('replaying the events a kernel took', () => {
  it('reproduces every deadline and expiry it held', () => {
    const h = new Harness().start()
    const events: Parameters<Harness['send']>[0][] = []
    const send = h.send.bind(h)
    h.send = event => {
      events.push(event)
      return send(event)
    }
    submit(h, liquidation(h, 'liq', { notAfter: 10_000 }), [seen(8_000)])
    observed(h, seen(3_000))
    observed(h, seen(6_000))
    h.tick(100)
    const fresh = new Harness().start()
    for (const event of events) fresh.send(event)
    expect(fresh.state.plans.liq?.notAfter).toBe(3_000)
    expect(fresh.state.observations[FACT]).toStrictEqual(h.state.observations[FACT])
    expect(fresh.state.plans).toStrictEqual(h.state.plans)
  })
})
