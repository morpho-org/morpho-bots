import { describe, expect, it } from 'vitest'

import type { KernelConfig, OkValidatorReading, PlanInput, TxPayload, Validator } from '../src'

import { argsOf, encodeCall, fnOf } from './codec'
import {
  cancel,
  ecrecoverPlan,
  FEE,
  FRESH_UNTIL,
  liquidationPlan,
  makeConfig,
  offer,
  publish,
  ratify,
  setterPlan,
  signTree,
  T,
  transfer,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId, treeRoot } from './validators'

const G1 = midnightId('g1')
const G2 = midnightId('g2')
const withLiveOffer = (config?: KernelConfig, before: (h: Harness) => void = () => {}) => {
  const h = new Harness(config).start()
  before(h)
  return h.liveOffer()
}

const cancelPlan = (h: Harness, intentId = 'cancel'): PlanInput => ({
  intentId,
  steps: [{ kind: 'tx', payload: h.entry(G1)!.spec.neutralizer }],
  notAfter: 1_000_000,
  basisBlock: 0
})

describe('an untrusted plan cannot hide or understate a commitment', () => {
  it('the reservation is the validator reading of the payload: the largest cap in the group', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: ecrecoverPlan('q', tree(offer('g1', 100n), offer('g1', 450n), offer('g2', 50n)))
    })
    expect(h.entry(G1)?.spec.cap).toBe(450n)
    expect(h.available(W.loan)).toBe(500n)
  })

  it('a publish carrying a signature over a tree with an extra group is refused before anything leaves', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    h.sign()
    const wider = tree(offer('g1', 300n), offer('g2', 900n))
    h.materialize(signatures => publish(wider, signatures[0]), wider)
    expect(h.lastReason('q')).toBe('exposes a commitment outside the plan')
    expect(h.commands('broadcast')).toHaveLength(0)
    expect(h.state.entries).toEqual({})
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('a dependent step cannot re-create a commitment an earlier step already signed', () => {
    const h = new Harness().start()
    const plan: PlanInput = {
      intentId: 'q',
      steps: [
        { kind: 'sign', payload: signTree(T), witness: T },
        { kind: 'tx', witness: T }
      ],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.sign()
    const larger = tree(offer('g1', 900n, { ratifier: W.setter }))
    h.materialize(() => ratify(treeRoot(larger)), larger)
    expect(h.lastReason('q')).toBe(`creates ${G1} that is already out`)
    expect(h.commands('sign')).toHaveLength(1)
  })

  it('a publish carrying a signature this plan never produced is refused at the commit point', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    h.sign()
    h.materialize(() => publish(T, 'sig(forged)'), T)
    h.simulate()
    h.sign()
    expect(h.lastReason('q')).toBe('carries a signature this plan did not produce')
    expect(h.commands('flush').filter(c => c.ledger.entries[G1])).toHaveLength(0)
    expect(h.commands('broadcast')).toHaveLength(0)
    expect(h.state.slot).toBeUndefined()
  })

  it('a ratification whose preimage does not hash to its root is refused at admission', () => {
    const h = new Harness().start()
    const claimed = tree(offer('g1', 1n, { ratifier: W.setter }))
    const real = tree(offer('g1', 900n, { ratifier: W.setter }))
    h.send({
      type: 'Submit',
      plan: {
        ...setterPlan('q', claimed),
        steps: [{ kind: 'tx', payload: ratify(treeRoot(real)), witness: claimed }]
      }
    })
    expect(h.lastReason('q')).toBe('tree preimage does not hash to root')
    expect(h.state.entries).toEqual({})
  })

  it('typed data no validator claims is refused, so a liquidator cannot sign an offer', () => {
    const h = new Harness(makeConfig({ validators: [makeConfig().validators[1]!] })).start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    expect(h.refusal('q')).toEqual({
      code: 'unauthorized',
      reason: 'no validator recognizes the action'
    })
  })

  it('typed data whose domain names another chain is refused before anything is signed', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: {
        ...ecrecoverPlan('q', T),
        steps: [
          { kind: 'sign', payload: signTree(T, 1n), witness: T },
          { kind: 'tx', witness: T }
        ]
      }
    })
    expect(h.lastReason('q')).toBe('typed data for another chain')
    expect(h.commands('sign')).toHaveLength(0)
  })

  it.each([
    ['no types', { types: {} }, 'unexpected typed data types'],
    [
      'a retyped root',
      { types: { OfferTree: [{ name: 'root', type: 'string' }] } },
      'unexpected typed data types'
    ],
    [
      'an extra domain field',
      { domain: { ...signTree(T).domain, name: 'Midnight' } },
      'unexpected typed data domain'
    ]
  ])('typed data with %s is refused before anything is signed', (_, change, reason) => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: {
        ...ecrecoverPlan('q', T),
        steps: [
          { kind: 'sign', payload: { ...signTree(T), ...change }, witness: T },
          { kind: 'tx', witness: T }
        ]
      }
    })
    expect(h.lastReason('q')).toBe(reason)
    expect(h.commands('sign')).toHaveLength(0)
  })

  it('a step calling itself compensation for a commitment the kernel does not own is refused', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'revoke',
        steps: [
          {
            kind: 'tx',
            payload: encodeCall(W.midnight, 'setConsumed', {
              group: 'g7',
              amount: (1n << 128n) - 1n,
              onBehalf: W.account
            })
          }
        ],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    expect(h.refusal('revoke')).toEqual({
      code: 'unauthorized',
      reason: 'neutralizes a commitment the kernel does not own'
    })
  })

  it('an admission that would exceed a cap is refused atomically', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('a', tree(offer('g1', 700n))) })
    h.send({ type: 'Submit', plan: ecrecoverPlan('b', tree(offer('g2', 400n))) })
    expect(h.refusal('b')).toEqual({ code: 'capacity', reason: `insufficient ${W.loan}` })
    expect(h.entry(G2)).toBeUndefined()
  })

  it('a builder that re-materializes a live commitment cannot demote or delete it', () => {
    const h = new Harness().start()
    const plan: PlanInput = {
      intentId: 'q',
      steps: [
        { kind: 'sign', payload: signTree(T), witness: T },
        { kind: 'tx', witness: T },
        { kind: 'sign', witness: T }
      ],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.entry(G1)?.state).toBe('live')
    h.advance('q')
    for (const command of h.pending('materialize')) {
      h.send({ type: 'Materialized', request: command.request, payload: signTree(T), witness: T })
    }
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'compensating',
      reason: `creates ${G1} that is already out`
    })
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.available(W.loan)).toBe(700n)
  })

  it('a dependent step that grows the cap of a still-intended commitment is refused by the cap check', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    const larger = tree(offer('g1', 900n, { ratifier: W.setter }))
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'q',
        steps: [{ kind: 'tx' }, { kind: 'tx', payload: ratify(treeRoot(t)), witness: t }],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    expect(h.entry(G1)?.state).toBe('intended')
    h.materialize(() => ratify(treeRoot(larger)), larger)
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'abandoned',
      reason: `creates ${G1} beyond its admitted bounds`
    })
  })

  it('the tree root binds the loan token, so evidence cannot re-point a reservation', () => {
    const h = new Harness().start()
    const real = tree(offer('g1', 300n, { ratifier: W.setter, loanToken: '0xWETH' }))
    const claimed = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'q',
        steps: [{ kind: 'tx', payload: ratify(treeRoot(real)), witness: claimed }],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'unauthorized',
      reason: 'tree preimage does not hash to root'
    })
  })

  it('a step that exposes a commitment no earlier step signed refuses the whole plan, so its earlier ratification never leaves', () => {
    const h = new Harness().start()
    const ratified = tree(offer('g1', 100n, { ratifier: W.setter }))
    const unsigned = tree(offer('g2', 100n))
    const plan: PlanInput = {
      intentId: 'q:X',
      steps: [
        { kind: 'tx', payload: ratify(treeRoot(ratified)), witness: ratified },
        { kind: 'tx', payload: publish(unsigned, 'sig(forged)'), witness: unsigned }
      ],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.drive()
    expect(h.notices('q:X')).toEqual(['refused'])
    expect(h.refusal('q:X')).toEqual({
      code: 'unauthorized',
      reason: 'exposes a commitment no earlier step signs'
    })
    expect(h.commands('sign')).toHaveLength(0)
    expect(h.commands('broadcast')).toHaveLength(0)
    expect(h.entry(G1)).toBeUndefined()
  })

  it('a commitment id the ledger already holds is never admitted again, so a live entry is never overwritten', () => {
    const h = withLiveOffer()
    expect(h.entry(G1)?.state).toBe('live')
    const live = structuredClone(h.entry(G1))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M2', tree(offer('g1', 50n))) })
    expect(h.notices('q:M2')).toEqual(['refused'])
    expect(h.lastReason('q:M2')).toBe(`commitment ${G1} exists`)
    expect(h.entry(G1)).toEqual(live)
    expect(h.available(W.loan)).toBe(700n)
  })
})

describe('a reading may claim only what its act records', () => {
  const LEAKY = '0xLeaky'
  const reads = (reading: Partial<OkValidatorReading>): Validator => ({
    id: 'leaky',
    version: 1,
    claims: p =>
      (p.kind === 'release' && p.channel === 'leaky') ||
      (p.kind === 'typed' && p.domain.verifyingContract === LEAKY),
    read: () => ({
      ok: true,
      creates: [],
      exposes: [],
      carries: [],
      retires: [],
      consumes: {},
      ...reading
    }),
    confirm: () => true
  })
  const spec = { id: 'leaky:1', exposure: 'broadcast' as const, resources: {}, cap: 1n, expiry: 1n }
  const steps: Record<'release' | 'sign', PlanInput['steps'][number]> = {
    release: { kind: 'release', payload: { kind: 'release', channel: 'leaky', message: {} } },
    sign: {
      kind: 'sign',
      payload: {
        kind: 'typed',
        domain: { verifyingContract: LEAKY },
        types: {},
        primaryType: 'X',
        message: {}
      }
    }
  }

  it.each([
    ['release', 'creates', { creates: [{ ...spec, neutralizer: cancel() }] }],
    ['release', 'consumes', { consumes: { [W.loan]: 1n } }],
    ['release', 'retires', { retires: [G1] }],
    ['sign', 'consumes', { consumes: { [W.loan]: 1n } }],
    ['sign', 'retires', { retires: [G1] }]
  ] as const)('refuses a %s step whose reading %s', (kind, _, reading) => {
    const config = makeConfig()
    const h = new Harness({ ...config, validators: [...config.validators, reads(reading)] }).start()
    h.send({
      type: 'Submit',
      plan: { intentId: 'leak', steps: [steps[kind]], notAfter: 1_000_000, basisBlock: 0 }
    })
    expect(h.refusal('leak')).toEqual({
      code: 'unauthorized',
      reason: `a ${steps[kind].payload!.kind} payload reads effects its act does not record`
    })
  })
})

describe('checks before every irreversible act', () => {
  it('a simulation failing before exposure abandons the plan and releases its reservation', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    expect(h.available(W.loan)).toBe(700n)
    h.simulate(false)
    expect(h.notices('q')).toEqual(['admitted', 'abandoned'])
    expect(h.state.entries).toEqual({})
    expect(h.available(W.loan)).toBe(1000n)
    expect(h.commands('sign')).toHaveLength(1)
  })

  it('a fact that changes while a simulation is outstanding stops its late result at the slot', () => {
    const h = new Harness().start()
    const fact = {
      id: 'liquidatable/p1',
      version: 'v1',
      basis: { block: h.block, blockHash: h.hash(h.block) }
    }
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq', { evidence: [fact], notAfter: FRESH_UNTIL }),
      observations: [fact]
    })
    h.send({ type: 'Observed', observations: [{ ...fact, version: 'v2' }] })
    h.simulate()
    expect(h.commands('sign')).toHaveLength(0)
    expect(h.notices('liq')).toEqual(['admitted', 'abandoned'])
    expect(h.lastReason('liq')).toBe('evidence liquidatable/p1 changed')
  })

  it('a supersession while a simulation is outstanding discards its late result', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    const [stale] = h.pending('simulate')
    h.send({ type: 'Submit', plan: liquidationPlan('next', { supersedes: 'liq' }) })
    h.send({
      type: 'Simulated',
      request: stale!.request,
      ok: true,
      block: h.block,
      blockHash: h.hash(h.block)
    })
    expect(h.commands('sign').filter(c => c.intentId === 'liq')).toHaveLength(0)
    expect(h.notices('liq')).toEqual(['admitted', 'abandoned'])
  })

  it('a supersession while a signature is outstanding releases the slot and discards the signed bytes', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    expect(h.state.slot).toBeDefined()
    const [stale] = h.pending('sign')
    h.send({ type: 'Submit', plan: liquidationPlan('next', { supersedes: 'liq' }) })
    expect(h.state.slot).toBeUndefined()
    h.send({ type: 'Signed', request: stale!.request, hash: '0xexec:liq', raw: 'raw(0xexec:liq)' })
    expect(h.candidates().filter(c => c.intentId === 'liq')).toEqual([])
    expect(h.commands('broadcast')).toHaveLength(0)
    expect(h.state.nextNonce).toBe(0)
  })

  it('a simulation that ages past the lag bound while signing is redone, and the signed bytes never leave', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.head()
    h.head()
    h.sign()
    expect(h.state.nonces).toEqual({})
    expect(h.commands('flush')).toHaveLength(1)
    expect(h.pending('simulate')).toHaveLength(1)
    expect(h.notices('liq')).toEqual(['admitted'])
  })

  it('the acknowledgement of an earlier flush does not release a later exposure', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    const commit = h.commands('flush').at(-1)!
    h.send({ type: 'Flushed', seq: commit.seq - 1 })
    expect(h.commands('broadcast')).toHaveLength(0)
    h.send({ type: 'Flushed', seq: commit.seq })
    expect(h.commands('broadcast')).toHaveLength(1)
  })

  describe.each(['Flushed', 'FlushFailed'] as const)('a %s answer', type => {
    const committed = () => {
      const h = new Harness().start()
      h.send({ type: 'Submit', plan: liquidationPlan('liq') })
      h.simulate()
      h.sign()
      return h
    }
    const answer = (h: Harness, seq: number) =>
      h.send(type === 'Flushed' ? { type, seq } : { type, seq, reason: 'io' })

    it.each([
      ['NaN', () => Number.NaN],
      ['unissued', (h: Harness) => h.state.seq + 1],
      ['zero', () => 0],
      ['negative', () => -1],
      ['fractional', (h: Harness) => h.state.seq - 0.5]
    ])('naming a %s flush changes nothing but an alarm', (_, seqOf) => {
      const h = committed()
      const before = structuredClone(h.state)
      answer(h, seqOf(h))
      expect(h.state).toStrictEqual(before)
      expect(h.commands('broadcast')).toHaveLength(0)
      expect(h.alarms()).toStrictEqual([`malformed ${type} event ignored`])
    })

    it('naming the issued flush is still taken', () => {
      const h = committed()
      answer(h, Number.NaN)
      answer(h, h.commands('flush').at(-1)!.seq)
      if (type === 'Flushed') expect(h.commands('broadcast')).toHaveLength(1)
      else expect(h.state.lifecycle.kind).toBe('recovering')
    })
  })

  it('stops rather than issue a flush whose sequence number an answer could not name', () => {
    const ledger = new Harness().start().ledger()!
    ledger.header.seq = Number.MAX_SAFE_INTEGER - 1
    const h = new Harness()
    h.boot('enrolled', ledger)
    h.head(1)
    h.nonceAt(0)
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    h.flush()
    expect(h.state.lifecycle).toMatchObject({
      kind: 'stopped',
      outcome: 'unsafe',
      reason: 'flush sequence exhausted'
    })
    expect(h.commands('flush').every(c => Number.isSafeInteger(c.seq))).toBe(true)
    expect(h.commands('broadcast')).toHaveLength(0)
  })

  it('stops rather than issue a request id past the exact integer range', () => {
    const h = new Harness().start()
    h.state.nextRequest = 2 ** 52 - 1
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    expect(h.state.lifecycle).toMatchObject({
      kind: 'stopped',
      outcome: 'unsafe',
      reason: 'request ids exhausted'
    })
    h.head()
    expect(h.log.every(c => !('request' in c) || Number.isSafeInteger(c.request))).toBe(true)
  })

  it('a simulation older than the lag bound is redone before signing', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('a') })
    h.send({ type: 'Submit', plan: liquidationPlan('b') })
    h.simulate()
    h.sign()
    h.head()
    h.head()
    h.flush()
    h.broadcast()
    expect(h.pending('simulate')).toHaveLength(1)
    expect(h.pending('simulate')[0]?.intentId).toBe('b')
  })

  it('a risk-increasing admission waits for a capacity read at or after our last final effect on it', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.capacity(W.loan, 500n, 1)
    const t = tree(offer('g1', 100n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('a', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.observe(G1, 40n)
    h.finalize(h.block)
    h.send({ type: 'Submit', plan: ecrecoverPlan('b', tree(offer('g2', 10n))) })
    expect(h.refusal('b')?.code).toBe('capacity')
    expect(h.lastReason('b')).toMatch(/not observed since our last effect/)
    h.capacity(W.loan, 460n)
    h.send({ type: 'Submit', plan: ecrecoverPlan('stale', tree(offer('g2', 10n))) })
    expect(h.refusal('stale')).toEqual({
      code: 'decision_predates_own_effect',
      reason: `decision predates our own final effect on ${W.loan}`
    })
    expect(h.notices('stale')).toEqual(['refused'])
    h.send({
      type: 'Submit',
      plan: ecrecoverPlan('c', tree(offer('g2', 10n)), { basisBlock: h.block })
    })
    expect(h.notices('c')).toEqual(['admitted'])
  })

  it('holds every fact a decision read to our own final effects, not only the latest', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.capacity(W.loan, 500n, 1)
    const t = tree(offer('g1', 100n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('a', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.observe(G1, 40n)
    h.finalize(h.block)
    h.capacity(W.loan, 460n)
    const read = (id: string, block: number) => ({
      id,
      version: 'v1',
      basis: { block, blockHash: h.hash(block) }
    })
    const decided = (intentId: string, oldest: number) =>
      h.send({
        type: 'Submit',
        plan: ecrecoverPlan(intentId, tree(offer('g2', 10n)), {
          basisBlock: h.block,
          evidence: [read('fresh', h.block), read('older', oldest)]
        }),
        observations: [
          { id: 'fresh', version: 'v1' },
          { id: 'older', version: 'v1' }
        ]
      })
    decided('stale', 1)
    expect(h.refusal('stale')?.code).toBe('decision_predates_own_effect')
    decided('fresh', h.block)
    expect(h.notices('fresh')).toEqual(['admitted'])
  })

  it('a halt narrows the policy for every later step of an admitted plan', () => {
    const h = withLiveOffer()
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'mixed',
        steps: [
          { kind: 'tx', payload: cancel() },
          {
            kind: 'tx',
            payload: encodeCall(W.executor, 'exec', { tag: 'x' })
          }
        ],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.drive()
    h.send({ type: 'Halt', reason: 'monitor' })
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.drive()
    expect(
      h.commands('sign').filter(c => c.payload.kind === 'tx' && fnOf(c.payload) === 'exec')
    ).toHaveLength(0)
    expect(h.commands('notify').at(-1)?.reason).toMatch(/policy now refuses/)
  })

  it('a halt that lands while a later step is being signed stops it at the final check', () => {
    const h = withLiveOffer()
    const exec: TxPayload = encodeCall(W.executor, 'exec', { tag: 'x' })
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'mixed',
        steps: [
          { kind: 'tx', payload: cancel() },
          { kind: 'tx', payload: exec }
        ],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.simulate()
    expect(fnOf(h.pending('sign')[0]?.payload)).toBe('exec')
    h.send({ type: 'Halt', reason: 'monitor' })
    h.sign()
    expect(h.candidates().filter(c => c.hash.startsWith('0xexec'))).toHaveLength(0)
    const failed = h
      .commands('notify')
      .find(c => c.intentId === 'mixed' && c.notice === 'compensating')
    expect(failed?.reason).toMatch(/final check: policy now refuses/)
  })

  it('a nonce fill submitted while running is refused, since it is allowed in recovery mode only', () => {
    const h = new Harness().start()
    const plan: PlanInput = {
      intentId: 'f',
      steps: [{ kind: 'tx', payload: { kind: 'tx', to: W.account, data: '0x', value: 0n } }],
      notAfter: 1_000_000,
      basisBlock: 0
    }
    h.send({ type: 'Submit', plan })
    h.drive()
    expect(h.notices('f')).toEqual(['refused'])
    expect(h.refusal('f')).toEqual({ code: 'unauthorized', reason: 'fill outside recovery' })
    expect(h.commands('simulate')).toHaveLength(0)
    expect(h.commands('broadcast')).toHaveLength(0)
  })
})

/** An object that holds itself, which no JSON encoding can carry. */
const cyclic = () => {
  const value: Record<string, unknown> = {}
  value.self = value
  return value
}

describe('what a plan read and what its own effect changed', () => {
  /** A plan resting on `position` still being liquidatable, read at `block`. */
  const resting = (
    h: Harness,
    intentId: string,
    position: string,
    block: number,
    conflicts: PlanInput['conflicts']
  ) => {
    const fact = {
      id: `liquidatable/${position}`,
      version: 'v1',
      basis: { block, blockHash: h.hash(block) }
    }
    h.send({
      type: 'Submit',
      plan: liquidationPlan(intentId, { evidence: [fact], conflicts, notAfter: FRESH_UNTIL }),
      observations: [{ id: fact.id, version: 'v1' }]
    })
  }

  it('an inclusion raises the ids its plan writes, so a fact read before it is refused', () => {
    const h = new Harness().start()
    resting(h, 'a', 'x', h.block, { writes: ['position:x'] })
    h.drive()
    h.head()
    h.head()
    h.mine(h.candidate('0xexec').hash)
    const included = h.block
    resting(h, 'stale', 'x', included - 1, { reads: ['position:x'] })
    expect(h.lastReason('stale')).toBe(
      'evidence liquidatable/x predates our own effect on position:x'
    )
    resting(h, 'other', 'y', included - 1, { reads: ['position:y'] })
    expect(h.notices('other')).toEqual(['admitted'])
    resting(h, 'fresh', 'x', included, { reads: ['position:x'] })
    expect(h.notices('fresh')).toEqual(['admitted'])
  })

  /** An inclusion on `position:x` at the returned block, flushed, then a restart. */
  const includedThenRestarted = (final: boolean, writes = ['position:x']) => {
    const h = new Harness().start()
    resting(h, 'a', 'x', h.block, { writes })
    h.drive()
    h.head()
    h.head()
    const sent = h.candidate('0xexec').hash
    h.mine(sent)
    const included = h.block
    if (final) h.finalize(included)
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(h.state.nextNonce!)
    for (const number of [included - 1, included])
      h.send({ type: 'Header', number, hash: h.hash(number) })
    if (!final) h.mine(sent, { block: included })
    expect(h.state.lifecycle.kind).toBe('running')
    return { h, included }
  }

  it('a restart keeps the ids an inclusion marked, so a fact read before it is still refused', () => {
    const { h, included } = includedThenRestarted(false)
    expect(h.state.conflictMarks['position:x']).toBe(included)
    resting(h, 'stale', 'x', included - 1, { reads: ['position:x'] })
    expect(h.lastReason('stale')).toBe(
      'evidence liquidatable/x predates our own effect on position:x'
    )
    resting(h, 'fresh', 'x', included, { reads: ['position:x'] })
    expect(h.notices('fresh')).toEqual(['admitted'])
  })

  it('carries any admitted conflict id through the ledger, a codec tag included', () => {
    const { h, included } = includedThenRestarted(false, ['$bigint', 'toString()'])
    expect(h.state.conflictMarks).toEqual({ $bigint: included, 'toString()': included })
    resting(h, 'stale', 'x', included - 1, { reads: ['$bigint'] })
    expect(h.lastReason('stale')).toBe('evidence liquidatable/x predates our own effect on $bigint')
  })

  it.each([
    ['an inherited property', { writes: ['constructor'] }, 'conflict id "constructor"'],
    ['the prototype', { reads: ['__proto__'] }, 'conflict id "__proto__"'],
    ['an empty id', { writes: [''] }, 'conflict id ""'],
    ['a control character', { writes: ['a\u0000b'] }, 'conflict id "a\\u0000b"'],
    ['an overlong id', { writes: ['x'.repeat(257)] }, 'conflict id "xxxx'],
    ['a number', { writes: [7] }, 'conflict id of type number'],
    ['a bigint', { writes: [1n] }, 'conflict id of type bigint'],
    ['a cyclic object', { writes: [cyclic()] }, 'conflict id of type object'],
    ['reads that are not a list', { reads: 'position:x' }, 'conflicts are not reads and writes']
  ])('refuses at admission a conflict id that is %s', (_, conflicts, reason) => {
    const h = new Harness().start()
    resting(h, 'odd', 'x', h.block, conflicts as never)
    expect(h.notices('odd')).toEqual(['refused'])
    expect(h.lastReason('odd')).toContain(reason)
    h.flush()
    h.crash()
    h.boot()
    expect(h.state.lifecycle.kind).toBe('starting')
  })

  it.each([
    ['an intent id that is an object', { intentId: cyclic() }, 'ids are not strings'],
    ['a submission id that is a bigint', { submissionId: 1n }, 'ids are not strings'],
    ['a fee ceiling that is an object', { maxSpendWei: cyclic() }, 'fee ceiling is not an amount'],
    [
      'evidence carrying a cyclic field',
      { evidence: [{ id: 'f', version: 'v', extra: cyclic() }] },
      'authority does not read back from the ledger as itself'
    ],
    [
      'evidence that names no block',
      { evidence: [{ id: 'f', version: 'v' }] },
      'evidence names no block'
    ],
    [
      'evidence that shadows the methods the kernel reads it with',
      {
        evidence: Object.assign(
          [{ id: 'f', version: 'v', basis: { block: 1, blockHash: '0x1' } }],
          {
            map: 0,
            flatMap: 0
          }
        )
      },
      'evidence is not a list'
    ],
    [
      'evidence whose hole hides an extra property',
      {
        evidence: Object.assign([], {
          1: { id: 'f', version: 'v', basis: { block: 1, blockHash: '0x1' } },
          map: 0
        })
      },
      'evidence is not a list'
    ]
  ])('refuses %s with a reason, never a throw', (_, extra, reason) => {
    const h = new Harness().start()
    expect(() =>
      h.send({ type: 'Submit', plan: { ...liquidationPlan('odd'), ...extra } as never })
    ).not.toThrow()
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'malformed',
      reason
    })
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('a mark outlives finality and a restart, and binds only the id it marks', () => {
    const { h, included } = includedThenRestarted(true)
    expect(h.state.conflictMarks['position:x']).toBe(included)
    resting(h, 'stale', 'x', included - 1, { reads: ['position:x'] })
    expect(h.lastReason('stale')).toBe(
      'evidence liquidatable/x predates our own effect on position:x'
    )
    resting(h, 'other', 'y', included - 1, { reads: ['position:y'] })
    expect(h.notices('other')).toEqual(['admitted'])
  })

  /** A signed offer released offchain by a plan writing `book`, flushed but not yet answered. */
  const releaseFlushed = () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'quote',
        steps: [
          { kind: 'sign', payload: signTree(t), witness: t },
          {
            kind: 'release',
            payload: {
              kind: 'release',
              channel: 'midnight-api',
              message: { root: treeRoot(t), signature: `sig(${treeRoot(t)})` }
            },
            witness: t
          }
        ],
        notAfter: 1_000_000,
        basisBlock: 0,
        conflicts: { writes: ['book'] }
      }
    })
    h.sign()
    h.flush()
    return h
  }

  it('a release raises the ids its plan writes past the head it went out at', () => {
    const h = releaseFlushed()
    h.head()
    expect(h.state.conflictMarks).toEqual({})
    h.release()
    expect(h.notices('quote')).toEqual(['admitted', 'settled'])
    const releasedAt = h.block
    h.head()
    resting(h, 'stale', 'x', releasedAt, { reads: ['book'] })
    expect(h.lastReason('stale')).toBe('evidence liquidatable/x predates our own effect on book')
    resting(h, 'fresh', 'x', releasedAt + 1, { reads: ['book'] })
    expect(h.notices('fresh')).toEqual(['admitted'])
  })

  it('a release answered at a head below one seen while it was out is marked past the highest', () => {
    const h = releaseFlushed()
    h.head(5)
    h.head(3)
    h.release()
    expect(h.state.conflictMarks).toEqual({ book: 6 })
  })

  it('a release that crashes between its flush and its answer stays owed, and a lagging restart marks it no lower', () => {
    const h = releaseFlushed()
    const lag = h.config.maxEvidenceAgeBlocks
    expect(h.pending('release')).toHaveLength(1)
    h.head(5)
    h.flush()
    h.crash()
    h.boot()
    expect(h.state.releases).toEqual({ quote: { writes: ['book'], after: 6, restored: true } })
    h.head(3)
    expect(h.state.conflictMarks).toEqual({ book: 6 + lag + 1 })
    expect(h.state.releases).toEqual({})
    h.head(9)
    expect(h.state.conflictMarks).toEqual({ book: 6 + lag + 1 })
    expect(h.commands('flush').at(-1)?.ledger).toMatchObject({
      conflictMarks: [['book', 6 + lag + 1]],
      releases: {}
    })
  })

  it('a release that crashes before the head it saw is durable is marked past it, however far the restart lags', () => {
    const h = releaseFlushed()
    const lag = h.config.maxEvidenceAgeBlocks
    const durable = h.state.releases.quote!.after
    h.head(lag)
    h.crash()
    h.boot()
    expect(h.state.releases.quote?.after).toBe(durable)
    expect(durable).toBeLessThan(lag)
    h.head(1)
    expect(h.state.conflictMarks.book).toBe(1 + lag + 2)
    expect(h.state.conflictMarks.book).toBeGreaterThan(lag)
  })

  it('a release restored onto a source lagging past the bound is marked past the head it last made durable', () => {
    const h = releaseFlushed()
    const lag = h.config.maxEvidenceAgeBlocks
    h.head(3 * lag)
    h.flush()
    h.head(3 * lag + 5)
    h.crash()
    h.boot()
    expect(h.state.releases.quote?.after).toBe(3 * lag + 1)
    h.head(1)
    expect(h.state.conflictMarks.book).toBe(4 * lag + 2)
    expect(h.state.conflictMarks.book).toBeGreaterThan(3 * lag + 5)
  })

  it('a release restored twice before any head is marked as if restored once', () => {
    const h = releaseFlushed()
    h.crash()
    h.boot()
    h.crash()
    h.boot()
    expect(h.state.releases.quote?.restored).toBe(true)
    h.head(7)
    expect(h.state.conflictMarks).toEqual({ book: 7 + h.config.maxEvidenceAgeBlocks + 2 })
  })

  it('a release owed across a restart is marked past the evidence age bound after the first head', () => {
    const h = releaseFlushed()
    h.crash()
    h.boot()
    h.head(7)
    expect(h.state.conflictMarks).toEqual({ book: 7 + h.config.maxEvidenceAgeBlocks + 2 })
  })

  it('a step that lands again after a shallow reorg raises its mark to the block it lands in', () => {
    const h = new Harness().start()
    resting(h, 'a', 'x', h.block, { writes: ['position:x'] })
    h.drive()
    h.head()
    h.head()
    const sent = h.candidate('0xexec').hash
    h.mine(sent)
    const first = h.block
    h.reorg(first - 1)
    h.head()
    h.head()
    h.mine(sent)
    expect(h.state.conflictMarks['position:x']).toBe(first + 1)
    resting(h, 'stale', 'x', first, { reads: ['position:x'] })
    expect(h.lastReason('stale')).toBe(
      'evidence liquidatable/x predates our own effect on position:x'
    )
  })

  it('a step that lands after a restart raises the marks of the plan that issued it', () => {
    const h = new Harness().start()
    resting(h, 'a', 'x', h.block, { writes: ['position:x'] })
    h.drive()
    const sent = h.candidate('0xexec').hash
    h.crash()
    h.boot()
    expect(h.state.plans).toEqual({})
    h.head()
    h.nonceAt(0, 1)
    h.head()
    h.mine(sent)
    expect(h.state.conflictMarks['position:x']).toBe(h.block)
    expect(h.commands('flush').at(-1)?.ledger.conflictMarks).toEqual([['position:x', h.block]])
  })

  it('evidence that has expired is refused at admission', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: { ...liquidationPlan('late'), notAfter: 0 } })
    expect(h.refusal('late')).toEqual({ code: 'evidence_expired', reason: 'evidence expired' })
    expect(h.notices('late')).toEqual(['refused'])
  })

  it('a final cancellation releases its reservation only against a balance read after it', () => {
    const h = withLiveOffer(makeConfig({ observedResources: [W.loan] }), h =>
      h.capacity(W.loan, 1000n, 1)
    )
    h.finalize(h.block)
    expect(h.available(W.loan)).toBe(700n)
    h.send({ type: 'Submit', plan: cancelPlan(h) })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    h.send({ type: 'Submit', plan: ecrecoverPlan('new', tree(offer('g2', 1000n))) })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'capacity',
      reason: `capacity of ${W.loan} not observed since our last effect on it`
    })
    h.capacity(W.loan, 700n)
    h.send({
      type: 'Submit',
      plan: ecrecoverPlan('too-big', tree(offer('g3', 1000n)), { basisBlock: h.block })
    })
    expect(h.notices('too-big')).toEqual(['refused'])
    h.send({
      type: 'Submit',
      plan: ecrecoverPlan('fits', tree(offer('g4', 700n)), { basisBlock: h.block })
    })
    expect(h.notices('fits')).toEqual(['admitted'])
  })

  it('3c. a final transaction releases its fee reserve only against a native balance read after it', () => {
    const h = new Harness(makeConfig({ observedResources: ['native'] })).start()
    h.capacity('native', 100n * FEE, 1)
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive()
    h.head()
    h.mine(h.candidate('0xexec').hash)
    h.finalize(h.block)
    h.send({ type: 'Submit', plan: liquidationPlan('liq2') })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'capacity',
      reason: 'capacity of native not observed since our last effect on it'
    })
    h.capacity('native', 99n * FEE)
    h.send({ type: 'Submit', plan: liquidationPlan('liq3') })
    expect(h.notices('liq3')).toEqual(['admitted'])
  })

  it('a decision older than our own final effect on a resource it uses does not go until its basis is refreshed', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.capacity(W.loan, 1000n, 1)
    const plan = (intentId: string, amount: bigint, tag: string): PlanInput => ({
      intentId,
      steps: [{ kind: 'tx', payload: transfer(amount, tag) }],
      notAfter: 1_000_000,
      basisBlock: 1
    })
    h.send({ type: 'Submit', plan: plan('a', 100n, 'a') })
    h.send({ type: 'Submit', plan: plan('b', 900n, 'b') })
    const sentFor = (tag: string) =>
      h.commands('broadcast').filter(({ hash }) => hash.startsWith(`0xtransfer:${tag}`))
    h.simulate()
    h.sign()
    h.flush()
    h.broadcast()
    expect(sentFor('a')).toHaveLength(1)
    expect(h.pending('sign')).toHaveLength(1)
    h.head()
    h.mine(h.candidate('0xtransfer:a').hash)
    h.finalize(h.block)
    h.capacity(W.loan, 900n)
    h.drive()
    expect(sentFor('b')).toHaveLength(0)
    expect(h.notices('b').at(-1)).toBe('abandoned')
  })

  it('a step whose own earlier step raised the watermark waits for a fresh basis instead of failing', () => {
    const h = new Harness(makeConfig({ observedResources: [W.loan] })).start()
    h.capacity(W.loan, 1000n, 1)
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
    expect(h.notices('two')).toEqual(['admitted'])
    expect(h.state.plans.two?.phase).toBe('awaiting-advance')
    h.advance('two')
    expect(argsOf(h.pending('simulate')[0]?.payload).amount).toBe(100n)
  })
})

describe('compensation', () => {
  it('a later step failing after an earlier one exposed compensates the exposure', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q')
    h.simulate(false)
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    h.drive()
    expect(h.entry(G1)?.state).toBe('revoking')
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    expect(h.available(W.loan)).toBe(700n)
    h.finalize(h.block)
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating', 'compensated'])
    expect(h.entry(G1)?.state).toBe('retired')
  })

  it('a ratification that reverts proves its commitment never existed: it retires at finality with nothing to cancel', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    const minedAt = h.block + 1
    for (let i = 0; i < 4; i++) h.head()
    h.send({ type: 'Header', number: minedAt, hash: h.hash(minedAt) })
    h.mine(h.candidate('0xsetIsRootRatified').hash, { block: minedAt, status: 'reverted' })
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'creator did not execute' })
    expect(h.commands('simulate').filter(c => fnOf(c.payload) === 'setConsumed')).toHaveLength(0)
    expect(h.notices('q')).toEqual(['admitted', 'compensating', 'compensated'])
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('compensation that cannot complete keeps the exposure and ends in recovery and an unsafe stop', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q')
    h.simulate(false)
    for (let i = 0; i < 3; i++) h.simulate(false)
    expect(h.entry(G1)).toMatchObject({ state: 'live', stuck: true })
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'compensation_failed' })
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating', 'failed'])
    h.tick(60_000)
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'unsafe' })
    expect(h.commands('report').at(-1)?.open.entries).toEqual([G1])
    expect(h.disk).toContain(G1)
  })

  it('an entry the decision graph stops affirming is withdrawn by the kernel on its own', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.tick(3_000_000)
    h.send({ type: 'Affirm', ids: [G1] })
    h.tick(3_000_000)
    expect(h.pending('simulate')).toHaveLength(0)
    h.tick(1_000_000)
    expect(fnOf(h.pending('simulate')[0]?.payload)).toBe('setConsumed')
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('compensation is complete only when the cancellation is final and its nonce resolved', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q')
    h.simulate(false)
    h.drive()
    expect(h.entry(G1)?.state).toBe('revoking')
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    h.finalize(h.block - 1)
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating'])
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.state.nonces).toEqual({})
    expect(h.notices('q')).toEqual(['admitted', 'advanced', 'compensating', 'compensated'])
  })

  it('a success without its expected log never proves the commitment absent', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash, { logs: [] })
    h.finalize(h.block)
    expect(h.entry(G1)?.state).not.toBe('retired')
    expect(h.alarms().at(-1)).toMatch(/without its expected transition/)
    expect(h.notices('q')).toEqual(['admitted', 'compensating'])
    expect(h.available(W.loan)).toBe(700n)
  })
})
