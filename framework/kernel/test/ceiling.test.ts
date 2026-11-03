import { describe, expect, it } from 'vitest'

import type { KernelConfig } from '../src'

import { latched, waitsAtCeiling } from '../src'
import { ecrecoverPlan, liquidationPlan, makeConfig, publish, T } from './fixtures'
import { Harness } from './harness'

type Outcome = 'accepted' | 'rejected' | 'unknown' | 'withheld' | 'timeout'

const CEILING_ALARM = 'nonce 0 waits at the fee ceiling'
const DEADLINE = 1_000

/** A step at nonce 0, accepted and then expired: it is cancelled and its nonce left to a fill. */
const cancelledStep = (config: Partial<KernelConfig> = {}) => {
  const h = new Harness(makeConfig(config)).start()
  h.send({ type: 'Submit', plan: liquidationPlan('liq', { notAfter: DEADLINE }) })
  h.drive()
  h.tick(DEADLINE)
  expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
  return h
}

const atCeiling = (h: Harness) => waitsAtCeiling(h.state, h.state.nonces[0]!)

/**
 * Bids fills at nonce 0 until one cannot be priced under the fee ceiling: each fill above level
 * `cap` is answered with the ceiling, and each one signed is sent and answered by `outcome`.
 */
const fillToCeiling = (h: Harness, cap: number, outcome: (level: number) => Outcome) => {
  for (let round = 0; round < 10 && !atCeiling(h); round++) {
    h.stall()
    h.simulate()
    for (const command of h.pending('sign'))
      if ('nonce' in command && command.feeLevel > cap)
        h.send({ type: 'FeeCeilingReached', request: command.request })
    h.sign()
    h.flush()
    for (const command of h.pending('broadcast'))
      h.broadcast(outcome(h.candidates().find(c => c.hash === command.hash)!.feeLevel))
  }
  expect(atCeiling(h)).toBe(true)
}

const fills = (h: Harness) => h.candidates().filter(c => c.kind === 'fill')
const fill = (h: Harness, level: number) => fills(h).find(c => c.feeLevel === level)!
const sendsOf = (h: Harness, hash: string) =>
  h.commands('broadcast').filter(c => c.hash === hash).length
const signsAt = (h: Harness, nonce: number) =>
  h.commands('sign').filter(c => 'nonce' in c && c.nonce === nonce).length
const ended = (h: Harness, intentId: string) =>
  h
    .commands('notify')
    .filter(c => c.intentId === intentId)
    .at(-1)

describe('a cancel ends a plan as cancelled only when nothing of it ran', () => {
  it('says cancelled on the last notice when the fill wins, and on no notice before it', () => {
    const h = cancelledStep()
    expect(h.commands('notify').at(-1)).not.toHaveProperty('code')
    fillToCeiling(h, 3, () => 'accepted')
    h.head()
    h.mine(fill(h, 2).hash)
    h.finalize(h.block)
    expect(h.notices('liq')).toEqual(['admitted', 'compensating', 'compensated'])
    expect(ended(h, 'liq')).toMatchObject({
      code: 'cancelled',
      reason: 'intent expired',
      included: []
    })
  })

  it('reports the step executed, and not cancelled, when its original wins after the cancel', () => {
    const h = cancelledStep()
    fillToCeiling(h, 3, () => 'accepted')
    const original = h.candidate('0xexec')
    h.head()
    h.mine(original.hash)
    expect(h.state.plans.liq?.included).toEqual([
      { step: 0, hash: original.hash, block: h.block, success: true }
    ])
    h.finalize(h.block)
    const last = ended(h, 'liq')
    expect(last).toMatchObject({ notice: 'compensated', reason: 'intent expired' })
    expect(last).not.toHaveProperty('code')
    expect(h.activity).toContainEqual(
      expect.objectContaining({ type: 'included', intentId: 'liq', hash: original.hash })
    )
  })
})

/** An offer published at nonce 0 and accepted, not yet mined, which expires at {@link DEADLINE}. */
const pendingOffer = (config: Partial<KernelConfig> = {}) => {
  const h = new Harness(makeConfig(config)).start()
  h.send({ type: 'Submit', plan: ecrecoverPlan('q:M1', T, { notAfter: DEADLINE }) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  expect(h.candidate('0xpublish')).toMatchObject({ nonce: 0, sent: 'accepted' })
  return h
}

/** Mines the fill at nonce 0 and the first neutralizer at nonce 1, and waits for both to be final. */
const fillAndNeutralizerWin = (h: Harness) => {
  h.stall()
  h.drive()
  h.head()
  h.mine(h.candidates().find(c => c.kind === 'fill')!.hash)
  h.mine(h.candidates().find(c => c.kind === 'neutralizer')!.hash)
  h.finalize(h.block)
  h.flush()
}

describe('a step recovery races with a fill is cancelled like any step that cannot bid again', () => {
  it.each(['fill', 'original'] as const)('and the %s winning ends it', winner => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive()
    h.send({ type: 'Stop' })
    expect(h.state.plans.liq).toMatchObject({ status: 'executing', phase: 'include' })
    h.stall()
    expect(h.notices('liq')).toEqual(['admitted', 'compensating'])
    expect(h.lastReason('liq')).toBe('recovering: stop requested')
    expect(h.commands('notify').at(-1)).not.toHaveProperty('code')
    h.drive()
    h.head()
    h.mine(winner === 'fill' ? fill(h, 2).hash : h.candidate('0xexec').hash)
    h.finalize(h.block)
    const last = ended(h, 'liq')
    expect(last?.notice).toBe('compensated')
    if (winner === 'fill') expect(last).toMatchObject({ code: 'cancelled', included: [] })
    else expect(last).not.toHaveProperty('code')
  })
})

describe('a cancel whose compensation acted never ends as cancelled', () => {
  it('when a neutralizer of its entry was committed before the cancel', () => {
    const h = pendingOffer({ revokeAfterStaleMs: 100 })
    h.tick(101)
    h.drive()
    expect(
      h
        .candidates()
        .filter(c => c.kind === 'neutralizer')
        .map(c => c.nonce)
    ).toEqual([1])
    h.tick(DEADLINE - 101)
    expect(h.notices('q:M1')).toEqual(['admitted', 'compensating'])
    fillAndNeutralizerWin(h)
    expect(h.notices('q:M1')).toEqual(['admitted', 'compensating', 'compensated'])
    expect(ended(h, 'q:M1')).not.toHaveProperty('code')
  })

  it('when a neutralizer of its entry is committed after the cancel', () => {
    const h = pendingOffer()
    h.tick(DEADLINE)
    h.drive()
    expect(
      h
        .candidates()
        .filter(c => c.kind === 'neutralizer')
        .map(c => c.nonce)
    ).toEqual([1])
    fillAndNeutralizerWin(h)
    expect(h.notices('q:M1')).toEqual(['admitted', 'compensating', 'compensated'])
    expect(ended(h, 'q:M1')).not.toHaveProperty('code')
  })

  it('names a step that lands after its plan ended in its inclusions', () => {
    const h = pendingOffer()
    h.tick(DEADLINE)
    for (let i = 0; i < h.config.maxRecoveryAttempts; i++) h.simulate(false)
    expect(ended(h, 'q:M1')).toMatchObject({ notice: 'failed', included: [] })
    h.head()
    const original = h.candidate('0xpublish').hash
    h.mine(original)
    const late = h.activity.filter(a => a.type === 'included' && a.intentId === 'q:M1')
    expect(late).toEqual([expect.objectContaining({ hash: original, success: true })])
  })
})

describe('a nonce no bid outbids under the fee ceiling', () => {
  it('stays live with one alarm, bids no more, and re-sends its highest fill until it lands', () => {
    const h = cancelledStep()
    fillToCeiling(h, 3, () => 'rejected')
    expect(fills(h).map(c => [c.feeLevel, c.sent])).toEqual([
      [2, 'rejected'],
      [3, 'rejected']
    ])
    expect(h.alarms().filter(a => a === CEILING_ALARM)).toHaveLength(1)
    expect(h.state.slot).toBeUndefined()
    const highest = fill(h, 3).hash
    const signs = signsAt(h, 0)
    const flushes = h.commands('flush').length
    const sends = sendsOf(h, highest)
    for (let i = 0; i < 3; i++) {
      h.stall()
      h.broadcast('rejected')
    }
    expect(sendsOf(h, highest)).toBe(sends + 3)
    expect(signsAt(h, 0)).toBe(signs)
    expect(h.commands('flush')).toHaveLength(flushes)
    expect(h.state.lifecycle.kind).toBe('running')
    expect(h.alarms().filter(a => a === CEILING_ALARM)).toHaveLength(1)
    expect(h.state.nonces[0]?.failedFillHead).toBeUndefined()

    h.head()
    h.mine(highest)
    h.finalize(h.block)
    expect(h.state.nonces).toEqual({})
    expect(ended(h, 'liq')).toMatchObject({ notice: 'compensated', code: 'cancelled' })
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('skips a withheld higher fill and re-sends the lower one', () => {
    const h = cancelledStep()
    fillToCeiling(h, 3, level => (level === 3 ? 'withheld' : 'rejected'))
    expect(fills(h).map(c => [c.feeLevel, c.sent])).toEqual([
      [2, 'rejected'],
      [3, 'withheld']
    ])
    const sends = [sendsOf(h, fill(h, 2).hash), sendsOf(h, fill(h, 3).hash)]
    h.stall()
    expect([sendsOf(h, fill(h, 2).hash), sendsOf(h, fill(h, 3).hash)]).toEqual([
      sends[0]! + 1,
      sends[1]
    ])
  })

  it('takes a re-sent rejected fill that is acknowledged as accepted, covering a lower unknown', () => {
    const h = cancelledStep({ latchBoundBlocks: 100 })
    fillToCeiling(h, 3, level => (level === 2 ? 'timeout' : 'rejected'))
    h.broadcast('timeout')
    expect(fills(h).map(c => c.sent)).toEqual(['unknown', 'rejected'])
    expect(latched(h.state)).toBe(true)
    h.stall()
    h.broadcast('accepted')
    expect(fills(h).map(c => c.sent)).toEqual(['unknown', 'accepted'])
    expect(latched(h.state)).toBe(false)
  })

  it('ages a re-send that times out as unknown, and clears the latch once the next is acknowledged', () => {
    const h = cancelledStep()
    fillToCeiling(h, 3, () => 'rejected')
    h.stall()
    h.broadcast('timeout')
    expect(fill(h, 3)).toMatchObject({ sent: 'unknown', unknownSince: h.block })
    expect(latched(h.state)).toBe(true)
    h.stall()
    h.broadcast('accepted')
    expect(fill(h, 3).sent).toBe('accepted')
    expect(fill(h, 3)).not.toHaveProperty('unknownSince')
    expect(latched(h.state)).toBe(false)
    expect(h.state.lifecycle.kind).toBe('running')
  })

  it('enters bounded recovery at once when the nonce has no recovery bid to re-send', () => {
    const h = cancelledStep()
    fillToCeiling(h, 1, () => 'rejected')
    expect(fills(h)).toEqual([])
    expect(h.state.lifecycle).toMatchObject({
      kind: 'recovering',
      reason: 'a nonce at the fee ceiling has no recovery bid to re-send'
    })
    h.tick(h.config.recoveryBoundMs)
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'unsafe' })
  })

  it('withholds bytes whose flush failed and never re-sends them, re-sending the lower fill', () => {
    const h = cancelledStep()
    h.stall()
    h.drive('rejected')
    h.stall()
    h.simulate()
    h.sign()
    const unflushed = fill(h, 3)
    h.send({ type: 'FlushFailed', seq: h.commands('flush').at(-1)!.seq, reason: 'io' })
    expect(unflushed.sent).toBe('unsent')
    expect(fill(h, 3).sent).toBe('withheld')
    h.stall()
    h.simulate()
    for (const command of h.pending('sign'))
      h.send({ type: 'FeeCeilingReached', request: command.request })
    expect(atCeiling(h)).toBe(true)
    h.stall()
    expect(h.pending('broadcast').map(c => c.hash)).toEqual([fill(h, 2).hash])
    h.flush()
    h.broadcast('rejected')
    h.stall()
    expect(h.pending('broadcast').map(c => c.hash)).toEqual([fill(h, 2).hash])
    expect(sendsOf(h, fill(h, 3).hash)).toBe(0)
  })

  it.each([
    ['Stop', { type: 'Stop' } as const, 'stop requested'],
    ['Halt', { type: 'Halt', reason: 'operator' } as const, 'operator']
  ])(
    'a %s recovers as it does today, and the re-sent bytes landing stop it clean',
    (_, event, reason) => {
      const h = cancelledStep()
      fillToCeiling(h, 3, () => 'rejected')
      h.send(event)
      expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason })
      const signs = signsAt(h, 0)
      h.stall()
      h.broadcast('accepted')
      expect(signsAt(h, 0)).toBe(signs)
      h.head()
      h.mine(fill(h, 3).hash)
      h.finalize(h.block)
      h.flush()
      expect(h.reports().at(-1)).toMatchObject({ outcome: 'clean' })
    }
  )
})

describe('a restart at the fee ceiling', () => {
  const restarted = () => {
    const h = cancelledStep()
    fillToCeiling(h, 3, () => 'accepted')
    h.flush()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(0)
    h.flush()
    return h
  }

  it('keeps running when the node still holds the bytes, and waits at the ceiling again', () => {
    const h = restarted()
    const highest = fill(h, 3).hash
    for (let i = 0; i < 4; i++) {
      h.stall()
      h.broadcast('accepted')
      h.simulate()
      for (const command of h.pending('sign'))
        h.send({ type: 'FeeCeilingReached', request: command.request })
    }
    expect(h.state.lifecycle.kind).toBe('running')
    expect(latched(h.state)).toBe(false)
    expect(atCeiling(h)).toBe(true)
    expect(h.commands('broadcast').at(-1)?.hash).toBe(highest)
  })

  it('takes the bounded recovery path when the node evicted the bytes and refuses them', () => {
    const h = restarted()
    for (let i = 0; i < 6; i++) {
      h.stall()
      h.broadcast('rejected')
      h.simulate()
      for (const command of h.pending('sign'))
        h.send({ type: 'FeeCeilingReached', request: command.request })
    }
    expect(h.state.lifecycle).toMatchObject({ kind: 'recovering', reason: 'latch bound exceeded' })
  })
})
