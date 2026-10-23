import { describe, expect, it } from 'vitest'

import type { PlanInput, Validator } from '../src'

import {
  ecrecoverPlan,
  liquidationPlan,
  makeConfig,
  offer,
  publish,
  ratify,
  setterPlan,
  T,
  transfer,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId, treeRoot } from './validators'

const G1 = midnightId('g1')
const oneStep = (intentId: string, to: string, data: string): PlanInput => ({
  intentId,
  steps: [{ kind: 'tx', payload: { kind: 'tx', to, data, value: 0n } }],
  notAfter: 1_000_000,
  basisBlock: 0
})

describe('payloads are the bytes that are signed', () => {
  it('refuses to start on an account that has code, since a nonce fill would run it', () => {
    const h = new Harness()
    h.send({
      type: 'Start',
      ledger: null,
      enrollment: 'enrolling',
      now: 0,
      accountCode: `0xef0100${'ab'.repeat(20)}`
    })
    expect(h.reports().at(-1)).toMatchObject({
      outcome: 'refused',
      reason: 'the account has code, so a nonce fill would run it'
    })
  })

  it('admits a target the policy spells in another letter case', () => {
    const config = makeConfig()
    const targets = config.policy.targets.map(t => (t === W.executor ? t.toUpperCase() : t))
    const h = new Harness({ ...config, policy: { ...config.policy, targets } }).start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    expect(h.notices('liq')).toEqual(['admitted'])
  })

  it('treats the account spelled in another case as the account', () => {
    const anyCase: Validator = {
      id: 'any-case',
      version: 1,
      claims: p => p.kind === 'tx' && p.to.toLowerCase() === W.account.toLowerCase(),
      read: () => ({ ok: true, creates: [], exposes: [], carries: [], retires: [], consumes: {} }),
      confirm: () => true
    }
    const config = makeConfig()
    const h = new Harness({
      ...config,
      validators: [...config.validators, anyCase],
      policy: { ...config.policy, targets: [...config.policy.targets, W.account.toUpperCase()] }
    }).start()
    h.send({ type: 'Submit', plan: oneStep('self', W.account.toUpperCase(), '0x1234') })
    expect(h.refusal('self')).toEqual({ code: 'unauthorized', reason: 'fill outside recovery' })
    expect(h.commands('sign')).toHaveLength(0)
  })

  it('knows a resubmission whose calldata differs only in hex case', () => {
    const h = new Harness().start()
    const first = liquidationPlan('one', { submissionId: 's' })
    h.send({ type: 'Submit', plan: first })
    h.drive()
    const step = first.steps[0]!
    const shouted =
      step.payload?.kind === 'tx'
        ? { ...step.payload, data: `0x${step.payload.data.slice(2).toUpperCase()}` }
        : step.payload
    h.send({
      type: 'Submit',
      plan: { ...first, intentId: 'two', steps: [{ ...step, payload: shouted }] }
    })
    expect(h.notices('two')).toEqual(['known'])
  })

  it.each([
    ['text that merely looks like hex', '0xAB', '0xab'],
    ['a number from the text naming it', 1n, '1n'],
    ['a number from the tag the ledger writes for one', 1n, { $bigint: '1' }]
  ])('keeps %s distinct, so two different plans never digest alike', (_, first, second) => {
    const h = new Harness().start()
    const noted = (intentId: string, note: unknown): PlanInput => {
      const plan = liquidationPlan('liq', { submissionId: 'same' })
      return { ...plan, intentId, steps: [{ ...plan.steps[0]!, witness: { note } }] }
    }
    h.send({ type: 'Submit', plan: noted('first', first) })
    h.send({ type: 'Submit', plan: noted('second', second) })
    expect(h.notices('second')).toEqual(['refused'])
    expect(h.refusal('second')).toEqual({
      code: 'duplicate',
      reason: 'submission same conflicts with its first payload'
    })
  })

  it.each([
    ['not hex', '0xzz'],
    ['an odd number of digits', '0xabc'],
    ['no 0x prefix', 'abcd']
  ])('refuses calldata that is %s before anything is signed', (_, data) => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: oneStep('bad', W.executor, data) })
    expect(h.refusal('bad')?.code).toBe('malformed')
    expect(h.lastReason('bad')).toMatch(/calldata is not whole bytes of hex$/)
    expect(h.commands('simulate')).toHaveLength(0)
  })
})

describe('malformed input is refused, never thrown out of the reducer', () => {
  it('an Affirm naming an inherited property affirms nothing, and leaves every prototype alone', () => {
    const h = new Harness().start()
    try {
      h.send({ type: 'Affirm', ids: ['__proto__', 'constructor'] })
      expect('affirmedAt' in {}).toBe(false)
      expect(h.state.entries).toStrictEqual({})
    } finally {
      delete (Object.prototype as { affirmedAt?: number }).affirmedAt
    }
  })

  it.each([
    ['without a list of ids', () => G1],
    ['naming an entry through a value that only coerces to its id', () => [[G1]]]
  ])('an Affirm %s changes nothing but an alarm', (_, ids) => {
    const h = new Harness().start().liveOffer()
    h.tick(1_000)
    const before = structuredClone(h.state)
    h.send({ type: 'Affirm', ids: ids() as unknown as string[] })
    expect(h.state).toStrictEqual(before)
    expect(h.alarms()).toStrictEqual(['malformed Affirm event ignored'])
  })

  it('refuses a plan carrying a function', () => {
    const h = new Harness().start()
    const plan = { ...liquidationPlan('fn'), steps: [{ kind: 'tx', witness: () => 0 }] }
    expect(() => h.send({ type: 'Submit', plan: plan as never })).not.toThrow()
    expect(h.refusal('fn')).toEqual({
      code: 'malformed',
      reason: 'step does not survive the ledger codec'
    })
  })

  it.each([
    ['a non-string target', { kind: 'tx', to: 7, data: '0x', value: 0n }],
    ['non-string calldata', { kind: 'tx', to: W.executor, data: 7, value: 0n }],
    ['a payload of no known kind', { kind: 'blob' }]
  ])('refuses a step with %s', (_, payload) => {
    const h = new Harness().start()
    const plan = { ...liquidationPlan('bad'), steps: [{ kind: 'tx', payload }] }
    expect(() => h.send({ type: 'Submit', plan: plan as never })).not.toThrow()
    expect(h.notices('bad')).toEqual(['refused'])
    expect(h.commands('simulate')).toHaveLength(0)
  })

  it.each([
    ['a function', () => 0],
    ['a non-string target', { kind: 'tx', to: 7, data: '0x', value: 0n }]
  ])('abandons a step materialized with %s', (_, payload) => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    const [request] = h.pending('materialize')
    expect(() =>
      h.send({ type: 'Materialized', request: request!.request, payload: payload as never })
    ).not.toThrow()
    expect(h.notices('q').at(-1)).toBe('abandoned')
  })

  it('starts compensating at once when an exposed plan materializes something uncloneable', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    const plan: PlanInput = {
      intentId: 'q',
      steps: [
        { kind: 'tx', payload: ratify(treeRoot(t)), witness: t },
        { kind: 'tx', witness: t }
      ],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q')
    const [request] = h.pending('materialize')
    const out = h.send({
      type: 'Materialized',
      request: request!.request,
      payload: (() => 0) as never
    })
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    expect(out.map(c => c.type)).toEqual(expect.arrayContaining(['simulate', 'flush']))
  })

  it('ignores a chain event it cannot clone, with an alarm', () => {
    const h = new Harness().start()
    const receipt = { type: 'Receipt', hash: '0x1', block: 1, blockHash: 'b1', status: 'success' }
    expect(() => h.send({ ...receipt, logs: [() => 0] } as never)).not.toThrow()
    expect(h.alarms().at(-1)).toBe('malformed Receipt event ignored')
  })

  it('a validator that throws in claims or confirm is contained', () => {
    const config = makeConfig()
    const midnight = config.validators[0]!
    const brokenClaims: Validator = {
      ...midnight,
      claims: () => {
        throw new Error('bug')
      }
    }
    const h1 = new Harness({
      ...config,
      validators: [brokenClaims, ...config.validators.slice(1)]
    }).start()
    h1.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    expect(h1.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'unauthorized',
      reason: 'validator midnight-offers threw in claims'
    })

    const brokenConfirm: Validator = {
      ...midnight,
      confirm: () => {
        throw new Error('bug')
      }
    }
    const h2 = new Harness({
      ...config,
      validators: [brokenConfirm, ...config.validators.slice(1)]
    }).start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h2.send({ type: 'Submit', plan: setterPlan('q', t) })
    h2.drive()
    h2.head()
    h2.mine(h2.candidate('0xsetIsRootRatified').hash)
    expect(h2.entry(G1)?.state).toBe('live')
    expect(h2.notices('q')).toEqual(['admitted', 'compensating'])
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'refuses %s as an id, since ids index the ledger and must never name an inherited property',
    id => {
      const h = new Harness().start()
      h.send({ type: 'Submit', plan: liquidationPlan(id) })
      h.send({ type: 'Submit', plan: { ...liquidationPlan('liq'), submissionId: id } })
      expect(h.commands('notify').map(({ notice }) => notice)).toEqual(['refused', 'refused'])
      expect(h.commands('simulate')).toHaveLength(0)
    }
  )

  it('a block or time that is not a non-negative safe integer never passes a comparison', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.capacity(W.loan, 1000n, 1)
    h.send({ type: 'Submit', plan: { ...liquidationPlan('nan'), basisBlock: Number.NaN } })
    h.send({ type: 'Submit', plan: { ...liquidationPlan('never'), notAfter: Infinity } })
    expect(h.notices('nan')).toEqual(['refused'])
    expect(h.notices('never')).toEqual(['refused'])
    expect([h.refusal('nan')?.code, h.refusal('never')?.code]).toEqual(['malformed', 'malformed'])

    h.send({
      type: 'Submit',
      plan: {
        intentId: 'two',
        steps: [
          { kind: 'tx', payload: transfer(100n, 'a') },
          { kind: 'tx', payload: transfer(100n, 'b') }
        ],
        notAfter: 1_000_000,
        basisBlock: 1
      }
    })
    h.simulate()
    h.sign()
    h.flush()
    h.head()
    h.mine(h.candidate('0xtransfer:a').hash)
    h.finalize(h.block)
    h.broadcast()
    expect(h.state.plans.two?.phase).toBe('awaiting-advance')
    for (const malformed of [
      { basisBlock: Number.NaN },
      { notAfter: Infinity },
      { notAfter: -1 }
    ]) {
      h.advance('two', malformed)
      expect(h.commands('notify').at(-1)).toMatchObject({
        intentId: 'two',
        notice: 'stalled',
        reason: 'basis block and expiry must be non-negative safe integers'
      })
    }
    expect(h.state.plans.two?.phase).toBe('awaiting-advance')
    expect(h.pending('simulate')).toHaveLength(0)

    const before = h.state.now
    h.send({ type: 'Tick', now: Number.NaN })
    expect(h.state.now).toBe(before)
    expect(h.alarms().at(-1)).toBe('malformed clock reading')
  })

  it.each([Number.NaN, -1, 1.5])('refuses to start on a malformed clock reading (%s)', now => {
    const h = new Harness()
    h.send({ type: 'Start', ledger: null, enrollment: 'enrolling', now, accountCode: '0x' })
    expect(h.state.lifecycle).toMatchObject({
      kind: 'stopped',
      outcome: 'refused',
      reason: 'malformed clock reading'
    })
  })

  it('a step whose kind disagrees with its payload is refused, so a transaction is never signed or released outside the slot', () => {
    const h = new Harness().start()
    const asSign: PlanInput = {
      intentId: 'x:sign',
      steps: [{ kind: 'sign', payload: transfer(100n) }],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    const asRelease: PlanInput = {
      intentId: 'x:release',
      steps: [{ kind: 'release', payload: transfer(100n) }],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan: asSign })
    h.send({ type: 'Submit', plan: asRelease })
    h.drive()
    h.release()
    for (const id of ['x:sign', 'x:release']) {
      expect(h.notices(id)).toEqual(['refused'])
      expect(h.refusal(id)).toEqual({
        code: 'malformed',
        reason: 'step kind does not match payload'
      })
    }
    expect(h.commands('sign')).toHaveLength(0)
    expect(h.commands('release')).toHaveLength(0)
    expect(h.available(W.loan)).toBe(1000n)
  })
})

describe('a neutralizer the validator supplies is checked like any payload', () => {
  it('never recovers with a neutralizer whose calldata is not whole bytes, however the validator reads it', () => {
    const config = makeConfig()
    const honest = config.validators[0]!
    const lax: Validator = {
      ...honest,
      read: (payload, evidence, context) => {
        if (payload.kind === 'tx' && payload.data === '0xzz')
          return {
            ok: true,
            creates: [],
            exposes: [],
            carries: [],
            retires: [midnightId('g1')],
            consumes: {}
          }
        const reading = honest.read(payload, evidence, context)
        if (!reading.ok) return reading
        const creates = reading.creates.map(c => ({
          ...c,
          neutralizer: { ...c.neutralizer, data: '0xzz' }
        }))
        return { ...reading, creates }
      }
    }
    const h = new Harness({ ...config, validators: [lax, ...config.validators.slice(1)] }).start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.send({ type: 'Stop' })
    h.drive()
    expect(h.commands('simulate').map(c => c.payload.data)).not.toContain('0xzz')
    expect(h.entry(midnightId('g1'))?.stuck).toBe(true)
  })
})
