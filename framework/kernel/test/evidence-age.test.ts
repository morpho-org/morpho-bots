import { describe, expect, it } from 'vitest'

import type { PlanInput } from '../src'

import { KernelConfigError } from '../src/errors'
import { liquidationPlan, makeConfig } from './fixtures'
import { Harness } from './harness'

const K = 4
const POSITION = 'position:x'
const FACT = 'liquidatable/x'

const aged = () => new Harness(makeConfig({ maxEvidenceAgeBlocks: K })).start()

/** Submits an act resting on the fact as read at `block`. */
const resting = (
  h: Harness,
  intentId: string,
  block: number,
  conflicts: PlanInput['conflicts'] = { reads: [POSITION] }
) =>
  h.send({
    type: 'Submit',
    plan: liquidationPlan(intentId, {
      evidence: [{ id: FACT, version: 'v1', basis: { block, blockHash: h.hash(block) } }],
      conflicts
    }),
    observations: [{ id: FACT, version: 'v1' }]
  })

/** Lands an act writing the position; its mark is the block it lands in. */
const landed = (h: Harness) => {
  resting(h, 'writer', h.block, { writes: [POSITION] })
  h.drive()
  h.head()
  h.mine(h.candidate('0xexec:writer').hash)
  expect(h.state.conflictMarks[POSITION]).toBe(h.block)
  return h.block
}

/** Heads until the floor reaches `mark`, the first one that prunes it. */
const pruneTo = (h: Harness, mark: number) => {
  while (h.block < mark + K) h.head()
  expect(h.state.conflictMarks[POSITION]).toBeUndefined()
  expect(h.state.evidenceFloor).toBe(mark)
}

const running = (h: Harness, nonce: number) => {
  h.nonceAt(nonce)
  expect(h.state.lifecycle.kind).toBe('running')
}

describe('the evidence age bound', () => {
  it('refuses a fact read more than its bound below head, and admits one read at it', () => {
    const h = aged()
    for (let i = 0; i < 2 * K; i++) h.head()
    resting(h, 'old', h.block - K - 1)
    expect(h.refusal('old')).toEqual({
      code: 'evidence_too_old',
      reason: `evidence ${FACT} read below block ${h.block - K}`
    })
    resting(h, 'edge', h.block - K)
    expect(h.notices('edge')).toEqual(['admitted'])
  })

  it('refuses a configured bound that is not an integer in its range', () => {
    for (const bound of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 32 + 1])
      expect(() => new Harness(makeConfig({ maxEvidenceAgeBlocks: bound as number }))).toThrow(
        KernelConfigError
      )
  })
})

describe('a conflict mark the evidence floor reaches', () => {
  it('is pruned with the floor raised to it in the same flush', () => {
    const h = aged()
    const mark = landed(h)
    pruneTo(h, mark)
    expect(h.commands('flush').at(-1)?.ledger).toMatchObject({
      conflictMarks: [],
      evidenceFloor: mark
    })
  })

  it('stays pruned across a restart, and the restored floor refuses what it could have refused', () => {
    const h = aged()
    const mark = landed(h)
    pruneTo(h, mark)
    h.flush()
    h.crash()
    h.boot()
    expect(h.state.evidenceFloor).toBe(mark)
    expect(h.state.conflictMarks).toEqual({})
    h.head(mark)
    running(h, 1)
    resting(h, 'before', mark - 1)
    expect(h.refusal('before')?.code).toBe('evidence_too_old')
    resting(h, 'after', mark)
    expect(h.notices('after')).toEqual(['admitted'])
  })

  it('keeps the floor at the mark when a reorg lowers the head below it plus the bound', () => {
    const h = aged()
    const mark = landed(h)
    pruneTo(h, mark)
    h.reorg(h.block - 1)
    h.head()
    resting(h, 'before', mark - 1)
    expect(h.refusal('before')?.code).toBe('evidence_too_old')
  })
})

describe('a restart', () => {
  it('with no prune since its last write may lower the floor, and the mark it kept still refuses', () => {
    const h = aged()
    const mark = landed(h)
    h.finalize(mark)
    expect(h.state.conflictMarks[POSITION]).toBe(mark)
    h.flush()
    h.crash()
    h.boot()
    expect(h.state.evidenceFloor).toBe(0)
    expect(h.state.conflictMarks[POSITION]).toBe(mark)
    h.head(mark - 1)
    running(h, 1)
    resting(h, 'before', mark - 1)
    expect(h.refusal('before')?.code).toBe('evidence_predates_own_effect')
  })

  it('after a prune that never became durable restores the marks it pruned', () => {
    const h = aged()
    const mark = landed(h)
    h.flush()
    pruneTo(h, mark)
    h.crash()
    h.boot()
    expect(h.state.evidenceFloor).toBe(0)
    expect(h.state.conflictMarks[POSITION]).toBe(mark)
  })
})
