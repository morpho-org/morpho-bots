import type { KeyedWrite } from '@repo/engine'
import type { KernelRequest } from '@repo/kernel'

import {
  createGraph,
  createRunner,
  digestOf,
  GraphDefinitionError,
  keyedLevel,
  keyedMap
} from '@repo/engine'
import { ABSENT } from '@repo/kernel'
import { describe, expect, it } from 'vitest'

import type { FactReading } from '../src'

import { act, advance, EvidenceDefectError, factOf, kernelDomain, withdrawal } from '../src'

const AT_1 = { block: 1, blockHash: '0x01' }
const AT_2 = { block: 2, blockHash: '0x02' }

const positions = () => {
  const g = createGraph('act')
  const domain = kernelDomain('base')
  const writes = g.occurrences<KeyedWrite<{ debt: number }>>('positions.writes')
  const level = keyedLevel(g, 'positions', writes)
  const open = domain.fact(keyedMap(g, 'open', level, ({ debt }) => (debt > 0 ? true : undefined)))
  return { g, domain, runner: createRunner(g.build()), writes, open }
}

describe('the evidence of a key', () => {
  it('reports the expiry of a key read as gone, implied gone, or projected gone', async () => {
    const { runner, writes, open } = positions()
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 0 } },
      basis: AT_1,
      expiry: 100
    })
    runner.push(writes, {
      coverage: 'carried',
      entries: {},
      absent: ['b'],
      basis: AT_2,
      expiry: 50
    })
    const keyed = runner.read(open)
    expect(factOf(open, keyed, 'a')).toStrictEqual({
      fact: { id: 'open/a', version: ABSENT, basis: AT_1 },
      expiry: 100
    })
    expect(factOf(open, keyed, 'b')).toStrictEqual({
      fact: { id: 'open/b', version: ABSENT, basis: AT_2 },
      expiry: 50
    })
    expect(factOf(open, keyed, 'z')).toStrictEqual({
      fact: { id: 'open/z', version: ABSENT, basis: AT_1 },
      expiry: 100
    })
    await runner.abandon()
  })

  it('reports no expiry for an absence whose read named none', async () => {
    const { runner, writes, open } = positions()
    runner.push(writes, { coverage: 'complete', entries: {}, basis: AT_1, empty: true })
    expect(factOf(open, runner.read(open), 'z')).toStrictEqual({
      fact: { id: 'open/z', version: ABSENT, basis: AT_1 }
    })
    await runner.abandon()
  })

  it('carries a chain read basis into the fact, so the kernel can refuse orphaned evidence', async () => {
    const { runner, writes, open } = positions()
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 5 }, b: { debt: 0 } },
      basis: { block: 7, blockHash: '0xb7' }
    })
    const keyed = runner.read(open)
    expect(factOf(open, keyed, 'a')).toStrictEqual({
      fact: { id: 'open/a', version: digestOf(true), basis: { block: 7, blockHash: '0xb7' } }
    })
    expect(factOf(open, keyed, 'b')).toStrictEqual({
      fact: { id: 'open/b', version: ABSENT, basis: { block: 7, blockHash: '0xb7' } }
    })
    await runner.abandon()
  })

  it.each([
    1,
    null,
    'api',
    [7, '0xb7'],
    { block: 7 },
    { block: '7', blockHash: '0xb7' },
    { block: -1, blockHash: '0xb7' },
    { block: 1.5, blockHash: '0xb7' }
  ])('refuses a key read at a basis that names no block: %j', async basis => {
    const { runner, writes, open } = positions()
    runner.push(writes, {
      coverage: 'carried',
      entries: { a: { debt: 5 } },
      absent: ['b'],
      basis
    })
    expect(() => factOf(open, runner.read(open), 'a')).toThrow(EvidenceDefectError)
    expect(() => factOf(open, runner.read(open), 'b')).toThrow(EvidenceDefectError)
    await runner.abandon()
  })

  it('gives no evidence for a key that is unknown or failed', async () => {
    const { runner, writes, open } = positions()
    expect(factOf(open, undefined, 'a')).toBeUndefined()
    runner.push(writes, {
      coverage: 'carried',
      entries: { a: { debt: 5 } },
      failed: ['b'],
      basis: { block: 7, blockHash: '0xb7' }
    })
    expect(factOf(open, runner.read(open), 'b')).toBeUndefined()
    runner.push(writes, { coverage: 'failed', keys: ['a'], reason: 'rpc' })
    expect(factOf(open, runner.read(open), 'a')).toBeUndefined()
    await runner.abandon()
  })
})

/**
 * Facts of one kernel: `a` read at block 7 until 300, `b` read at block 9 until 200, and `c` read
 * at block 9 with no expiry.
 */
const twoFacts = async () => {
  const g = createGraph('grounds')
  const domain = kernelDomain('base')
  const writes = g.occurrences<KeyedWrite<number>>('writes')
  const first = domain.fact(keyedLevel(g, 'first', writes))
  const otherWrites = g.occurrences<KeyedWrite<number>>('other.writes')
  const second = domain.fact(keyedLevel(g, 'second', otherWrites))
  const unboundedWrites = g.occurrences<KeyedWrite<number>>('unbounded.writes')
  const third = domain.fact(keyedLevel(g, 'third', unboundedWrites))
  const runner = createRunner(g.build())
  runner.push(unboundedWrites, {
    coverage: 'complete',
    entries: { c: 3 },
    basis: { block: 9, blockHash: '0x09' }
  })
  runner.push(writes, {
    coverage: 'complete',
    entries: { a: 1 },
    basis: { block: 7, blockHash: '0x07' },
    expiry: 300
  })
  runner.push(otherWrites, {
    coverage: 'complete',
    entries: { b: 2 },
    basis: { block: 9, blockHash: '0x09' },
    expiry: 200
  })
  const a = factOf(first, runner.read(first), 'a')!
  const b = factOf(second, runner.read(second), 'b')!
  const c = factOf(third, runner.read(third), 'c')!
  await runner.abandon()
  return { domain, a, b, c }
}

const STEPS = [{ kind: 'tx' as const }]
const base = { intentId: 'k#run.0', steps: STEPS, conflicts: {} }

describe('a plan built by act', () => {
  it('rests on every fact it read, in order', async () => {
    const { domain, a, b } = await twoFacts()
    expect(act(domain, { ...base, restsOn: [b, a] }).evidence).toStrictEqual([b.fact, a.fact])
  })

  it('is based at the latest block of its facts and of anything else it read', async () => {
    const { domain, a, b } = await twoFacts()
    expect(act(domain, { ...base, restsOn: [a, b] }).basisBlock).toBe(9)
    expect(act(domain, { ...base, restsOn: [a], readAt: 8 }).basisBlock).toBe(8)
  })

  it('stops at the earliest of its own validity and every fact it read', async () => {
    const { domain, a, b } = await twoFacts()
    expect(act(domain, { ...base, restsOn: [a, b] }).notAfter).toBe(200)
    expect(act(domain, { ...base, restsOn: [a, b], validUntil: 150 }).notAfter).toBe(150)
  })

  it('refuses grounds that name no deadline', async () => {
    const { domain, c } = await twoFacts()
    expect(() => act(domain, { ...base, restsOn: [c] })).toThrow(EvidenceDefectError)
    expect(act(domain, { ...base, restsOn: [c], validUntil: 150 }).notAfter).toBe(150)
  })

  it('names its conflicts as given, and none when they name nothing', async () => {
    const { domain, a } = await twoFacts()
    const conflicts = { reads: ['x'], writes: [] }
    expect(act(domain, { ...base, restsOn: [a], conflicts }).conflicts).toBe(conflicts)
    expect(act(domain, { ...base, restsOn: [a], conflicts: { writes: [] } })).not.toHaveProperty(
      'conflicts'
    )
  })

  it('passes its submission id and decision through untouched', async () => {
    const { domain, a } = await twoFacts()
    const decision = { key: 'k', priority: '5' }
    const plan = act(domain, { ...base, restsOn: [a], submissionId: 'saga', decision })
    expect(plan.submissionId).toBe('saga')
    expect(plan.decision).toBe(decision)
  })

  it('refuses to rest on no fact', async () => {
    const { domain } = await twoFacts()
    expect(() => act(domain, { ...base, restsOn: [] })).toThrow(EvidenceDefectError)
  })

  it('refuses a reading factOf did not make from one of its own facts', async () => {
    const { domain, a } = await twoFacts()
    const other = await twoFacts()
    const forged = { fact: a.fact } as FactReading<'base'>
    expect(() => act(domain, { ...base, restsOn: [forged] })).toThrow(EvidenceDefectError)
    expect(() => act(domain, { ...base, restsOn: [other.a] })).toThrow(EvidenceDefectError)
  })
})

describe('a withdrawal', () => {
  it('rests on nothing, at the block it was decided at', async () => {
    const { domain } = await twoFacts()
    expect(withdrawal(domain, { ...base, basisBlock: 4, expiresAt: 1_000 })).toStrictEqual({
      intentId: 'k#run.0',
      steps: STEPS,
      basisBlock: 4,
      notAfter: 1_000
    })
  })
})

describe('an advance', () => {
  it('rests on its stage facts, based after the plan its stage continues', async () => {
    const { domain, a, b } = await twoFacts()
    expect(
      advance(domain, { intentId: 'k#run.0', stage: 1, restsOn: [a, b], readAt: 12 })
    ).toStrictEqual({
      type: 'Advance',
      intentId: 'k#run.0',
      stage: 1,
      basisBlock: 12,
      evidence: [a.fact, b.fact],
      notAfter: 200
    })
  })
})

describe('the fact registry', () => {
  it('refuses a fact registered with a second kernel, or after its kernel took its facts', () => {
    const g = createGraph('registry')
    const first = kernelDomain('first')
    const node = first.fact(keyedLevel(g, 'node', g.occurrences<KeyedWrite<number>>('writes')))
    expect(() => kernelDomain('second').fact(node)).toThrow(GraphDefinitionError)
    expect(first.facts()).toStrictEqual([node])
    const late = keyedLevel(g, 'late', g.occurrences<KeyedWrite<number>>('late.writes'))
    expect(() => first.fact(late)).toThrow(GraphDefinitionError)
  })
})

describe('the types of a plan', () => {
  it('refuse a hand-built plan, and a fact of another kernel', async () => {
    const { domain, a } = await twoFacts()
    const other = kernelDomain('other')
    const handBuilt = { intentId: 'x', steps: STEPS, notAfter: 1, basisBlock: 0 }
    // @ts-expect-error a plan carries evidence only through act or withdrawal
    const forged: KernelRequest = { type: 'Submit', plan: handBuilt }
    // @ts-expect-error an advance carries evidence only through advance
    const advanced: KernelRequest = {
      type: 'Advance',
      intentId: 'x',
      stage: 1,
      basisBlock: 0,
      notAfter: 1
    }
    const built: KernelRequest = { type: 'Submit', plan: act(domain, { ...base, restsOn: [a] }) }
    // @ts-expect-error a plan's brand is not an advance's
    const relabelled: KernelRequest = {
      ...withdrawal(domain, { ...base, basisBlock: 0, expiresAt: 1 }),
      type: 'Advance',
      stage: 1
    }
    expect([forged, advanced, built, relabelled]).toHaveLength(4)
    // @ts-expect-error a fact of `base` is not one of `other`
    expect(() => act(other, { ...base, restsOn: [a] })).toThrow(EvidenceDefectError)
  })

  it('cannot be changed after it is built, nor can the readings it rests on', async () => {
    const { domain, a, b } = await twoFacts()
    const plan = act(domain, { ...base, restsOn: [a] })
    // @ts-expect-error an authored plan's evidence is fixed
    expect(() => (plan.evidence = [b.fact])).toThrow(TypeError)
    expect(() => Object.assign(a.fact, b.fact)).toThrow(TypeError)
    expect(plan.evidence).toStrictEqual([
      { id: 'first/a', version: a.fact.version, basis: { block: 7, blockHash: '0x07' } }
    ])
  })

  it("freezes a reading's fact and basis", async () => {
    const { a } = await twoFacts()
    expect(() => Object.assign(a, { expiry: 1 })).toThrow(TypeError)
    expect(() => Object.assign(a.fact, { version: 'changed' })).toThrow(TypeError)
    expect(() => Object.assign(a.fact.basis, { block: 8 })).toThrow(TypeError)
    expect(a.fact).toStrictEqual({
      id: 'first/a',
      version: a.fact.version,
      basis: { block: 7, blockHash: '0x07' }
    })
  })
})
