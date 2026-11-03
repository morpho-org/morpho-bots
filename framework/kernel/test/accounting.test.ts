import { describe, expect, it } from 'vitest'

import { createKernel } from '../src'
import { cancel, FEE, offer, setterPlan, transfer, tree, W } from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')

/** Puts a plan's committed step back to bidding at a nonce no stuck rule would re-bid, a rejected one. */
const rebidRejected = (h: Harness, intentId: string) => {
  const plan = h.state.plans[intentId]!
  plan.phase = 'await-slot'
  plan.sim = { block: h.block, blockHash: h.hash(h.block) }
  h.tick(0)
}

const withFinalOffer = () => {
  const h = new Harness().start().liveOffer()
  h.finalize(h.block)
  return h
}

const send = (h: Harness, intentId = 'send') =>
  h.send({
    type: 'Submit',
    plan: {
      intentId,
      steps: [{ kind: 'tx', payload: transfer(100n) }],
      notAfter: 1_000_000,
      basisBlock: 0
    }
  })

/** Stops, letting recovery cancel the live offer at a fresh nonce, and returns that neutralizer. */
const cancelOnStop = (h: Harness, outcome: 'accepted' | 'rejected' = 'accepted') => {
  h.send({ type: 'Stop' })
  h.simulate()
  h.sign()
  h.flush()
  h.broadcast(outcome)
  return h.candidate('0xsetConsumed')
}

const cancels = (h: Harness) => h.candidates().filter(c => c.hash.startsWith('0xsetConsumed'))

/** A send that times out, and whose one re-send times out too, so recovery fills its nonce. */
const timedOut = (h: Harness) => {
  send(h)
  h.drive('timeout')
  h.stall()
  h.broadcast('timeout')
}

describe('a nonce is counted once, however many candidates bid at it', () => {
  it('a recovery fill at an occupied nonce holds one fee reserve and one consumption', () => {
    const h = new Harness().start()
    timedOut(h)
    const fill = Object.values(h.state.plans).find(p => p.recovery?.kind === 'fill')
    expect(fill?.phase).toBe('simulate')
    expect(h.available('native')).toBe(99n * FEE)
    expect(h.available(W.loan)).toBe(900n)
    h.drive()
    expect(h.state.nonces[0]?.candidates).toHaveLength(2)
    expect(h.available('native')).toBe(99n * FEE)
    expect(h.available(W.loan)).toBe(900n)
  })

  it("a step's second candidate consumes nothing more, and the nonce's winner settles the step", () => {
    const h = new Harness().start()
    send(h)
    h.drive()
    const original = h.candidate('0xtransfer')
    h.stall()
    h.drive()
    expect(h.notices('send')).toEqual(['admitted'])
    expect(h.state.nonces[0]?.candidates.map(c => c.feeLevel)).toEqual([1, 2])
    expect(h.state.plans['send']?.committedConsumes).toEqual({ [W.loan]: 100n })
    expect(h.available(W.loan)).toBe(900n)
    expect(h.available('native')).toBe(99n * FEE)
    h.head()
    h.mine(original.hash)
    expect(h.notices('send')).toEqual(['admitted', 'settled'])
    expect(h.state.plans['send']?.included).toEqual([
      { step: 0, hash: original.hash, block: h.block, success: true }
    ])
  })
})

describe('creators are recorded by nonce', () => {
  it('a step that created a commitment may bid again at its nonce, and either candidate creates it', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    expect(h.entry(G1)).toMatchObject({ state: 'exposed', creators: [0] })
    h.stall()
    h.drive()
    expect(h.notices('q')).toEqual(['admitted'])
    const [, again] = h.state.nonces[0]!.candidates
    expect(again?.creates).toEqual([G1])
    expect(h.entry(G1)?.creators).toEqual([0])
    h.head()
    h.mine(again!.hash)
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.state.plans['q']?.cursor).toBe(1)
  })
})

describe("an entry's hand-back is decided by its nonce", () => {
  it('an older neutralizer that wins keeps the entry, though a newer one at its nonce loses', () => {
    const h = withFinalOffer()
    const older = cancelOnStop(h)
    h.stall()
    h.drive()
    expect(cancels(h).map(c => c.nonce)).toEqual([older.nonce, older.nonce])
    h.head()
    h.mine(older.hash)
    expect(h.entry(G1)?.state).toBe('revoking')
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    h.flush()
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'clean' })
  })

  it.each(['accepted', 'rejected'] as const)(
    'a withheld neutralizer leaves the entry revoking while an %s one retires it at its nonce',
    outcome => {
      const h = withFinalOffer()
      const first = cancelOnStop(h, outcome)
      if (outcome === 'accepted') {
        h.stall()
        h.simulate()
      } else rebidRejected(h, first.intentId)
      h.sign()
      expect(h.entry(G1)?.state).toBe('revoking')
      h.tick(h.config.maxDispatchLagMs + 1)
      h.flush()
      expect(cancels(h).map(c => c.sent)).toEqual([outcome, 'withheld'])
      expect(h.entry(G1)).toMatchObject({ state: 'revoking', neutralizing: { nonce: first.nonce } })
      h.head()
      h.mine(first.hash)
      h.finalize(h.block)
      expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    }
  )

  /** Two accepted cancellations and a fill at one nonce, the fill provisionally winning. */
  const fillWinsOverCancels = () => {
    const h = withFinalOffer()
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'c',
        steps: [{ kind: 'tx', payload: cancel() }],
        notAfter: 1e6,
        basisBlock: 0
      }
    })
    h.drive()
    h.stall()
    h.drive()
    expect(cancels(h).map(c => c.sent)).toEqual(['accepted', 'accepted'])
    h.tick(1e6)
    h.stall()
    h.drive()
    const fill = h.candidate('0xfill')
    const nonce = cancels(h)[0]!.nonce
    expect(fill.nonce).toBe(nonce)
    expect(h.entry(G1)?.state).toBe('revoking')
    h.head()
    h.mine(fill.hash)
    return { h, nonce, cancel: cancels(h)[0]! }
  }

  it('a fill that wins hands the entry back, though accepted cancellations at its nonce retire it', () => {
    const { h } = fillWinsOverCancels()
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.entry(G1)?.neutralizing).toBeUndefined()
  })

  it('a reorg that orphans the winning fill returns the entry to its cancellations, which retire it', () => {
    const { h, nonce, cancel: original } = fillWinsOverCancels()
    h.reorg(h.block - 1)
    expect(h.entry(G1)).toMatchObject({ state: 'revoking', neutralizing: { nonce } })
    h.head()
    h.mine(original.hash)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    expect(h.state.nonces[nonce]).toBeUndefined()
  })

  it('a restart returns a handed-back entry to the cancellations its unresolved nonce still holds', () => {
    const { h, nonce, cancel: original } = fillWinsOverCancels()
    h.flush()
    expect(h.ledger()!.entries[G1]).toMatchObject({ state: 'live' })
    h.crash()
    h.boot()
    expect(h.entry(G1)).toMatchObject({ state: 'revoking', neutralizing: { nonce } })
    h.head()
    h.mine(original.hash)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
  })
})

describe('nothing is signed at a nonce that resolved after it was asked for', () => {
  it('a fill whose nonce resolves while it is signed is refused and records nothing', () => {
    const h = new Harness().start()
    timedOut(h)
    h.simulate()
    const [sign] = h.pending('sign')
    h.mine(h.candidate('0xtransfer').hash)
    expect(createKernel(h.config).signRefusal(h.state, sign!.request, h.now)).toBe(
      'the request was withdrawn'
    )
    h.sign()
    expect(h.candidates().map(c => c.kind)).toEqual(['step'])
    expect(Object.values(h.state.plans).filter(p => p.recovery)).toEqual([])
  })
})
