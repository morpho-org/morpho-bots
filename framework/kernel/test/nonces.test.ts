import { describe, expect, it } from 'vitest'

import { createKernel, latched } from '../src'
import {
  ecrecoverPlan,
  FEE,
  liquidationPlan,
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
const withFinalOffer = () => {
  const h = new Harness().start()
  h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  h.head()
  h.mine(h.candidate('0xpublish').hash)
  h.finalize(h.block)
  return h
}

const quote = (
  h: Harness,
  intentId: string,
  group: string,
  outcome: 'accepted' | 'timeout' = 'accepted'
) => {
  const t = tree(offer(group, 300n))
  h.send({ type: 'Submit', plan: ecrecoverPlan(intentId, t) })
  h.sign()
  h.materialize(signatures => publish(t, signatures[0]), t)
  h.drive(outcome)
}

type FillFailure =
  | 'simulation refusal'
  | 'simulation failure'
  | 'sign failure'
  | 'sign timeout'
  | 'withholding'

const startFill = (h = new Harness().start(), intentId = 'liq') => {
  h.send({ type: 'Submit', plan: liquidationPlan(intentId) })
  h.simulate()
  h.sign()
  h.flush()
  h.broadcast('rejected')
  expect(h.pending('simulate')).toHaveLength(1)
  return h
}

const failFill = (h: Harness, failure: FillFailure) => {
  if (failure === 'simulation refusal') return h.simulate(false)
  if (failure === 'simulation failure') {
    h.send({ type: 'EffectFailed', request: h.pending('simulate')[0]!.request })
    return
  }
  h.simulate()
  if (failure === 'sign failure' || failure === 'sign timeout') {
    h.send({
      type: failure === 'sign failure' ? 'EffectFailed' : 'TimedOut',
      request: h.pending('sign')[0]!.request
    })
    return
  }
  h.sign()
  h.tick(h.config.maxDispatchLagMs + 1)
  h.flush()
}

const executingFills = (h: Harness) =>
  Object.values(h.state.plans).filter(
    plan => plan.status === 'executing' && plan.recovery?.kind === 'fill'
  )

describe('nonces and the latch', () => {
  it.each([
    'simulation refusal',
    'simulation failure',
    'sign failure',
    'sign timeout',
    'withholding'
  ] as const)('a recovery fill whose %s fails waits for a later head', failure => {
    const h = startFill()
    failFill(h, failure)
    expect(h.state.nonces[0]?.failedFillHead).toBe(h.block)
    expect(executingFills(h)).toHaveLength(0)

    h.tick(1)
    h.head(h.block)
    expect(executingFills(h)).toHaveLength(0)

    h.head()
    expect(executingFills(h)).toHaveLength(1)
    h.tick(1)
    h.head(h.block)
    expect(executingFills(h)).toHaveLength(1)
  })

  it('a failed recovery fill does not delay a fill for another nonce', () => {
    const h = startFill()
    failFill(h, 'simulation failure')
    h.send({ type: 'Submit', plan: liquidationPlan('other') })
    h.simulate()
    h.sign()
    h.flush()
    h.broadcast('rejected')

    expect(executingFills(h).map(plan => plan.recovery?.targetNonce)).toEqual([1])
  })

  it('a failed recovery fill does not delay a neutralizer', () => {
    const h = startFill(withFinalOffer(), 'liq')
    failFill(h, 'simulation failure')
    h.send({ type: 'Stop' })

    const neutralizers = Object.values(h.state.plans).filter(
      plan => plan.status === 'executing' && plan.recovery?.kind === 'neutralizer'
    )
    expect(neutralizers.map(plan => plan.recovery?.targetNonce)).toEqual([1])
  })

  it('a failed recovery fill pace mark is process-local', () => {
    const h = startFill()
    h.flush()
    failFill(h, 'simulation failure')
    expect(h.state.nonces[0]?.failedFillHead).toBe(h.block)

    const block = h.block
    h.crash()
    h.boot()
    h.head(block)
    h.nonceAt(0)
    expect(h.state.nonces[0]?.failedFillHead).toBeUndefined()
    expect(executingFills(h)).toHaveLength(1)
  })

  it('a timed-out broadcast is unknown, latches, and is reconciled when it lands late', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive('timeout')
    const hash = h.candidate('0xexec').hash
    expect(h.candidate('0xexec').sent).toBe('unknown')
    expect(latched(h.state)).toBe(true)
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K2') })
    expect(h.notices('liq:K2')).toEqual(['refused'])
    expect(h.refusal('liq:K2')?.code).toBe('unauthorized')
    h.send({ type: 'Broadcasted', hash, outcome: 'accepted' })
    expect(latched(h.state)).toBe(false)
    h.head()
    h.head()
    h.mine(hash, { block: h.block - 1 })
    expect(h.notices('liq:K1')).toEqual(['admitted', 'settled'])
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K2') })
    expect(h.notices('liq:K2')).toEqual(['refused', 'admitted'])
  })

  it('a latch never clears on time or on a late rejection: past its bound the kernel recovers', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive('timeout')
    h.send({ type: 'Broadcasted', hash: h.candidate('0xexec').hash, outcome: 'rejected' })
    expect(latched(h.state)).toBe(true)
    for (let i = 0; i < 10; i++) h.head()
    expect(latched(h.state)).toBe(true)
    expect(h.state.lifecycle.kind).toBe('running')
    h.head()
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'latch bound exceeded' })
    expect(latched(h.state)).toBe(true)
  })

  it('a replacement cancel that loses to the original publication leaves it live and cancels again', () => {
    const h = new Harness().start()
    quote(h, 'q:A', 'g1', 'timeout')
    const original = h.candidate('0xpublish')
    h.send({ type: 'Stop' })
    h.drive()
    const cancel = h.candidate('0xsetConsumed')
    expect(cancel.nonce).toBe(original.nonce)
    expect(h.entry(G1)?.state).toBe('revoking')
    h.head()
    h.mine(original.hash)
    expect(h.entry(G1)?.state).toBe('live')
    h.drive()
    const second = h.candidates().find(c => c.hash.startsWith('0xsetConsumed') && c.nonce === 1)
    expect(second).toBeDefined()
    h.finalize(h.block)
    expect(h.state.lifecycle.kind).toBe('recovering')
    h.head()
    h.mine(second!.hash)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'clean' })
  })

  it('multiple unresolved nonces are each contested, and each winner is reconciled on its own', () => {
    const h = new Harness().start()
    quote(h, 'q:A', 'g1')
    quote(h, 'q:B', 'g2')
    expect(h.candidates().map(c => [c.nonce, c.sent])).toEqual([
      [0, 'accepted'],
      [1, 'accepted']
    ])
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0, 2)
    h.observe(G1)
    h.observe(G2)
    expect(h.candidates().map(c => c.sent)).toEqual(['unknown', 'unknown'])
    expect(latched(h.state)).toBe(true)
    for (let i = 0; i < 11; i++) h.head()
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering' })
    h.drive()
    const cancels = h.candidates().filter(c => c.kind === 'neutralizer')
    expect(cancels.map(c => [c.nonce, c.retires[0]])).toEqual([
      [0, G1],
      [1, G2]
    ])
    h.head()
    h.mine(cancels[0]!.hash)
    h.mine(h.candidates().find(c => c.nonce === 1 && c.kind === 'step')!.hash)
    expect(h.entry(G1)?.state).toBe('revoking')
    expect(h.entry(G2)?.state).toBe('live')
    h.drive()
    const retry = h.candidates().find(c => c.kind === 'neutralizer' && c.nonce === 2)
    expect(retry?.retires).toEqual([G2])
    h.head()
    h.mine(retry!.hash)
    h.finalize(h.block)
    expect([h.entry(G1)?.state, h.entry(G2)?.state]).toEqual(['retired', 'retired'])
    expect(h.available(W.loan)).toBe(1000n)
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'clean' })
  })

  it('a nonce consumed by a transaction the kernel cannot identify stays unresolved and held', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive()
    h.head()
    h.nonceAt(1)
    expect(h.commands('findNonceTx')).toEqual([{ type: 'findNonceTx', nonce: 0 }])
    h.finalize(h.block + 5)
    expect(Object.keys(h.state.nonces)).toEqual(['0'])
    expect(h.available('native')).toBe(99n * FEE)
    h.send({ type: 'Stop' })
    h.tick(60_000)
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'unsafe' })
    expect(h.commands('report').at(-1)?.open.nonces).toEqual([0])
  })

  it('a nonce identified as consumed by a transaction the kernel never signed halts and keeps its record, so no stop is clean', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
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
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering' })
    expect(h.alarms().at(-1)).toMatch(/never signed/)
    expect(h.available('native')).toBe(100n * FEE)
    h.finalize(h.block)
    expect(h.state.nonces[0]?.foreign).toBe(true)
    h.tick(10_000_000)
    expect(h.reports().at(-1)).toMatchObject({
      outcome: 'unsafe',
      open: { nonces: [0] }
    })
  })

  it('a rejected first broadcast is not proof the transaction cannot run: its nonce is filled', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive('rejected')
    expect(latched(h.state)).toBe(false)
    h.drive()
    const fill = h.candidate('0xfill')
    expect(fill.nonce).toBe(0)
    h.head()
    h.mine(fill.hash)
    h.finalize(h.block)
    expect(h.state.nonces).toEqual({})
    expect(h.notices('liq:K1')).toEqual(['admitted', 'compensating', 'compensated'])
  })

  it('a clean stop waits for an unknown-outcome liquidation to resolve at finality', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive('timeout')
    h.send({ type: 'Stop' })
    h.head()
    expect(h.state.lifecycle.kind).toBe('recovering')
    for (let i = 0; i < 3; i++) h.head()
    h.drive()
    const fill = h.candidate('0xfill')
    const original = h.candidate('0xexec')
    h.head()
    h.mine(original.hash)
    expect(h.state.lifecycle.kind).toBe('recovering')
    expect(h.commands('report')).toHaveLength(0)
    expect(Object.values(h.state.nonces)[0]?.resolution?.winner).toBe(original.hash)
    expect(Object.values(h.state.nonces)[0]?.candidates.map(c => c.hash)).toEqual([
      original.hash,
      fill.hash
    ])
    h.finalize(h.block)
    expect(h.state.nonces).toEqual({})
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'clean' })
  })

  it('a late timeout of a rebroadcast cannot mark an unflushed candidate as sent', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive('timeout')
    for (let i = 0; i < 3; i++) h.head()
    const rebroadcast = h.pending('broadcast')[0]!
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.advance('q')
    h.simulate()
    h.sign()
    expect(h.candidate('0xpublish').sent).toBe('unsent')
    h.send({ type: 'TimedOut', request: rebroadcast.request })
    expect(h.candidate('0xpublish').sent).toBe('unsent')
    for (let i = 0; i < 4; i++) h.head()
    expect(h.commands('broadcast').filter(c => c.hash.startsWith('0xpublish'))).toHaveLength(0)
  })

  it.each(['TimedOut', 'EffectFailed'] as const)(
    'a signing %s frees the exposure slot for the next plan and for recovery',
    type => {
      const h = withFinalOffer()
      h.send({ type: 'Submit', plan: liquidationPlan('a') })
      h.simulate()
      const signing = h.pending('sign')[0]!
      h.send({ type, request: signing.request })
      expect(h.state.slot).toBeUndefined()
      h.send({ type: 'Submit', plan: liquidationPlan('b') })
      h.simulate()
      expect(
        h
          .pending('sign')
          .filter(c => c.request !== signing.request)
          .map(c => c.intentId)
      ).toEqual(['b'])
      h.sign()
      h.flush()
      h.broadcast()
      h.send({ type: 'Stop' })
      h.drive()
      expect(h.broadcastsTo('setConsumed')).toHaveLength(1)
    }
  )

  it('an unrecorded pending transaction is an open obligation, never a clean stop', () => {
    const h = new Harness().start()
    const before = h.available('native')
    h.nonceAt(0, 1)
    expect(h.state.lifecycle.kind).toBe('recovering')
    expect(Object.keys(h.state.nonces)).toEqual(['0'])
    expect(h.available('native')).toBe(before - h.config.feeReserve)
    expect(latched(h.state)).toBe(true)
    h.drive()
    h.flush()
    h.head()
    expect(h.reports()).toHaveLength(0)
    expect(h.commands('sign')).toHaveLength(0)
    expect(h.disk).toContain('"nonce":0')
    h.tick(60_000)
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'unsafe', open: { nonces: [0] } })
  })

  it('an expired plan is not rebroadcast while latched', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq', { notAfter: 10 }) })
    h.drive('timeout')
    expect(latched(h.state)).toBe(true)
    h.tick(11)
    for (let i = 0; i < 4; i++) h.head()
    expect(h.broadcastsTo('exec')).toHaveLength(1)
  })

  it('an unexpired plan is rebroadcast from its stored bytes while latched', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive('timeout')
    for (let i = 0; i < 4; i++) h.head()
    expect(h.broadcastsTo('exec').map(c => c.raw)).toEqual([
      h.candidate('0xexec').raw,
      h.candidate('0xexec').raw
    ])
  })

  it('lets the handoff of a re-send through on the rebroadcast rule, not the first dispatch rule', () => {
    const h = new Harness().start()
    const kernel = createKernel(h.config)
    h.send({ type: 'Submit', plan: liquidationPlan('liq', { notAfter: 10_000 }) })
    h.drive('timeout')
    const { hash } = h.candidate('0xexec')
    const pastDispatchWindow = h.now + h.config.maxDispatchLagMs + 1
    expect(kernel.withholds(h.state, 'liq', pastDispatchWindow)).toBe(
      'lifecycle forbids this action'
    )
    expect(kernel.withholds(h.state, 'liq', pastDispatchWindow, hash)).toBeUndefined()
    expect(kernel.withholds(h.state, 'liq', 10_000, hash)).toBe('re-send revoked')
    h.send({ type: 'Halt', reason: 'operator' })
    expect(kernel.withholds(h.state, 'liq', pastDispatchWindow, hash)).toBe('re-send revoked')
  })

  it('while latched, a neutral plan of dependent steps is refused at admission and leaves no trace', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive('timeout')
    expect(latched(h.state)).toBe(true)
    h.send({
      type: 'Submit',
      plan: { intentId: 'later', steps: [{ kind: 'tx' }], notAfter: 1_000_000, basisBlock: 0 }
    })
    expect(h.notices('later')).toEqual(['refused'])
    expect(h.state.plans['later']).toBeUndefined()
    expect(h.pending('materialize')).toHaveLength(0)
  })

  it('a withheld recovery neutralizer hands its entry back, and recovery occupies the nonce again', () => {
    const h = withFinalOffer()
    h.send({ type: 'Stop' })
    h.simulate()
    h.sign()
    const withheld = h.candidate('0xsetConsumed')
    expect(h.entry(G1)?.state).toBe('revoking')
    h.tick(h.config.maxDispatchLagMs + 1)
    h.flush()
    expect(h.broadcastsTo('setConsumed')).toHaveLength(0)
    expect(h.candidate('0xsetConsumed').sent).toBe('withheld')
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.available(W.loan)).toBe(700n)
    h.drive()
    const retry = h.candidates().filter(c => c.kind === 'neutralizer' && c.hash !== withheld.hash)
    expect(retry.map(c => c.nonce)).toEqual([withheld.nonce])
    expect(h.broadcastsTo('setConsumed')).toHaveLength(1)
    expect(h.entry(G1)?.state).toBe('revoking')
    h.head()
    h.mine(retry[0]!.hash)
    expect(h.entry(G1)?.state).toBe('revoking')
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'clean' })
  })
})

describe('replacement candidates', () => {
  it('mutually exclusive candidates reserve the largest, not the sum, until the nonce is final', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'send',
        steps: [{ kind: 'tx', payload: transfer(100n) }],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.drive('timeout')
    for (let i = 0; i < 11; i++) h.head()
    expect(h.state.lifecycle.kind).toBe('recovering')
    for (let i = 0; i < 3; i++) h.head()
    h.drive()
    const fill = h.candidate('0xfill')
    expect(fill.nonce).toBe(0)
    expect(Object.values(h.state.nonces)[0]?.candidates).toHaveLength(2)
    expect(h.available(W.loan)).toBe(900n)
    expect(h.available('native')).toBe(99n * FEE)
    h.head()
    h.mine(fill.hash)
    expect(h.available(W.loan)).toBe(900n)
    h.finalize(h.block)
    expect(h.available(W.loan)).toBe(1000n)
    expect(h.available('native')).toBe(100n * FEE)
  })

  it('a replacement neutralizer that wins proves the original unable to run; a late receipt for it is ignored', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive('timeout')
    const original = h.candidate('0xsetIsRootRatified')
    h.send({ type: 'Stop' })
    for (let i = 0; i < 3; i++) h.head()
    h.drive()
    const cancel = h.candidate('0xsetConsumed')
    expect(cancel.nonce).toBe(original.nonce)
    h.head()
    h.mine(cancel.hash)
    expect(h.entry(G1)?.state).toBe('revoking')
    expect(h.available(W.loan)).toBe(700n)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired' })
    h.mine(original.hash)
    expect(h.state.nonces).toEqual({})
    h.flush()
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'clean' })
  })

  it.each(['original', 'replacement'] as const)(
    'a step and its recovery replacement share one nonce; when the %s wins the plan follows it',
    winner => {
      const h = new Harness().start()
      h.send({ type: 'Submit', plan: liquidationPlan('liq') })
      h.drive('timeout')
      const original = h.candidate('0xexec')
      h.send({ type: 'Stop' })
      for (let i = 0; i < 3; i++) h.head()
      h.drive()
      const fill = h.candidate('0xfill')
      expect(Object.values(h.state.nonces)[0]?.candidates.map(c => c.hash)).toEqual([
        original.hash,
        fill.hash
      ])
      expect(h.available('native')).toBe(99n * FEE)
      h.head()
      h.mine(winner === 'original' ? original.hash : fill.hash)
      expect(h.notices('liq')).toEqual(
        winner === 'original' ? ['admitted', 'settled'] : ['admitted', 'compensating']
      )
      expect(h.reports()).toHaveLength(0)
      h.finalize(h.block)
      expect(h.state.nonces).toEqual({})
      if (winner === 'replacement')
        expect(h.notices('liq')).toEqual(['admitted', 'compensating', 'compensated'])
      expect(h.reports()).toHaveLength(0)
      h.flush()
      expect(h.reports().at(-1)).toMatchObject({ outcome: 'clean' })
    }
  )
})
