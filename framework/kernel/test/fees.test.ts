import { describe, expect, it } from 'vitest'

import type { FeeContext, KernelConfig } from '../src'

import { ecrecoverPlan, FEE, liquidationPlan, makeConfig, publish, T } from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
const signFees = (h: Harness) => h.commands('sign').flatMap(c => ('fee' in c ? [c.fee] : []))

const liveOffer = (config: KernelConfig, maxSpendWei?: bigint) => {
  const h = new Harness(config).start()
  h.send({
    type: 'Submit',
    plan: ecrecoverPlan('q:M1', T, maxSpendWei === undefined ? {} : { maxSpendWei })
  })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  h.head()
  h.mine(h.candidate('0xpublish').hash)
  h.finalize(h.block)
  return h
}

describe('fees', () => {
  it("a plan's fee ceiling bounds its own candidates below the policy ceiling", () => {
    const h = new Harness(makeConfig({ feePolicy: () => FEE })).start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1', { maxSpendWei: FEE / 4n }) })
    h.simulate()
    h.sign()
    expect(signFees(h)).toEqual([FEE / 4n])
    expect(h.candidate('0xexec').fee).toBe(FEE / 4n)
    h.flush()
    expect(h.disk).toContain(`"$bigint":"${FEE / 4n}"`)
  })

  it('the fee policy decides within the ceilings, and is clamped to the policy ceiling', () => {
    const low = new Harness(makeConfig({ feePolicy: () => FEE / 10n })).start()
    low.send({ type: 'Submit', plan: liquidationPlan('liq:K1', { maxSpendWei: FEE / 2n }) })
    low.simulate()
    low.sign()
    expect(signFees(low)).toEqual([FEE / 10n])

    const high = new Harness(makeConfig({ feePolicy: () => 5n * FEE })).start()
    high.send({ type: 'Submit', plan: liquidationPlan('liq:K2') })
    high.simulate()
    high.sign()
    expect(signFees(high)).toEqual([FEE])
  })

  it("recovery neutralizers ignore the plan's ceiling, so a low ceiling can't stop a cancellation", () => {
    const h = liveOffer(makeConfig({ feePolicy: () => FEE }), 1n)
    expect(signFees(h)).toEqual([1n])
    h.send({ type: 'Stop' })
    h.simulate()
    h.sign()
    expect(h.candidate('0xsetConsumed').kind).toBe('neutralizer')
    expect(h.candidate('0xsetConsumed').fee).toBe(FEE)
  })

  it('a fee policy that throws fails a step before exposure, but recovery still prices at the ceiling', () => {
    let broken = false
    const h = liveOffer(
      makeConfig({
        feePolicy: () => {
          if (broken) throw new Error('fee oracle down')
          return FEE / 2n
        }
      })
    )
    broken = true
    const before = h.available('native')
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.simulate()
    expect(h.commands('sign').filter(c => c.intentId === 'liq:K1')).toHaveLength(0)
    expect(h.notices('liq:K1')).toEqual(['admitted', 'abandoned'])
    expect(h.available('native')).toBe(before)
    h.send({ type: 'Stop' })
    h.simulate()
    h.sign()
    expect(h.candidate('0xsetConsumed').fee).toBe(FEE)
    expect(h.entry(G1)?.state).toBe('revoking')
  })

  it('a non-positive plan ceiling is refused at admission and reserves nothing', () => {
    const h = new Harness().start()
    const before = h.available('native')
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1', { maxSpendWei: 0n }) })
    expect(h.notices('liq:K1')).toEqual(['refused'])
    expect(h.refusal('liq:K1')?.code).toBe('malformed')
    expect(h.available('native')).toBe(before)
  })

  it('a submission id is bound to its fee ceiling as well as its steps', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq:a', { submissionId: 'saga/0', maxSpendWei: FEE / 2n })
    })
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq:a', { submissionId: 'saga/0', maxSpendWei: FEE })
    })
    expect(h.notices('liq:a')).toEqual(['admitted', 'refused'])
    expect(h.refusal('liq:a')?.code).toBe('duplicate')
  })

  it('a replacement is recorded at the nonce, level and fee it was signed at', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq:K1') })
    h.drive('rejected')
    h.drive()
    const signed = h.commands('sign').flatMap(c => ('nonce' in c ? [c] : []))
    expect(signed.map(c => [c.nonce, c.feeLevel])).toEqual([
      [0, 1],
      [0, 2]
    ])
    const fill = h.candidate('0xfill')
    expect(fill).toMatchObject({ nonce: 0, feeLevel: 2, fee: signed[1]!.fee })
    expect(fill.hash).toMatch(/:n0:f2$/)
  })

  it('the fee policy is told the candidate kind, nonce, replacement level, and admission head', () => {
    const seen: FeeContext[] = []
    const h = liveOffer(
      makeConfig({
        feePolicy: context => {
          seen.push(context)
          return FEE
        }
      })
    )
    const publishContext = seen.at(-1)!
    expect(publishContext).toMatchObject({ kind: 'step', level: 1 })
    h.send({ type: 'Stop' })
    h.simulate()
    h.sign()
    const neutralizer = seen.at(-1)!
    expect(neutralizer.kind).toBe('neutralizer')
    expect(neutralizer.level).toBe(1)
    expect(neutralizer.nonce).toBe(publishContext.nonce + 1)
  })
})
