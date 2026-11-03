import type { Candidate, Entry, KernelConfig, KernelState, NonceRecord, Plan } from '@repo/kernel'

import { createKernel } from '@repo/kernel'
import { describe, expect, it } from 'vitest'

import { isBusy } from '../src'
import { viewOf } from '../src/view'

const config = { validators: [], caps: {}, maxEvidenceAgeBlocks: 0 } as unknown as KernelConfig

const entry = (id: string, intentId: string, state: Entry['state'], adopted = false): Entry => ({
  spec: {
    id,
    exposure: 'inclusion',
    resources: { 'loan:0xusdc': 100n },
    expiry: 0n,
    cap: 100n,
    neutralizer: { kind: 'tx', to: '0x', data: '0x', value: 0n }
  },
  state,
  intentId,
  validator: 'v@1',
  creators: [],
  deadCreators: [],
  consumedFinal: 0n,
  recoveryAttempts: 0,
  stuck: false,
  compensate: false,
  affirmedAt: 0,
  ...(adopted && { adopted: true as const })
})

describe('the kernel view', () => {
  it('holds a key busy on every entry that carries risk, revoking and adopted ones included', () => {
    const state = {
      ...createKernel(config).initialState(),
      lifecycle: { kind: 'running' as const },
      entries: {
        live: entry('live', 'l#run.0', 'live'),
        revoking: entry('revoking', 'v#run.0', 'revoking'),
        adopted: entry('adopted', 'a#earlier.3', 'live', true),
        retired: entry('retired', 'r#run.0', 'retired')
      }
    }
    const view = viewOf(state)
    expect(
      ['l', 'v', 'a', 'r', 'unseen', 'constructor'].map(key => isBusy(view, key))
    ).toStrictEqual([true, true, true, false, false, false])
  })

  const sent = (intentId: string, status: Candidate['sent'] = 'accepted') =>
    ({ intentId, step: 0, sent: status }) as Candidate
  const record = (nonce: number, candidate: Candidate, resolved = false): NonceRecord => ({
    nonce,
    candidates: [candidate],
    lastActionHead: 1,
    openedAt: 0,
    ...(resolved && { resolution: {} as NonceRecord['resolution'] })
  })
  const plan = (intentId: string, status: Plan['status'] = 'executing', nonce?: number) =>
    ({ intentId, status, cursor: 0, ...(nonce !== undefined && { terms: { nonce } }) }) as Plan
  const running = (overrides: Partial<KernelState>): KernelState => ({
    ...createKernel(config).initialState(),
    lifecycle: { kind: 'running' },
    ...overrides
  })

  it('holds a key busy on a send until its record is pruned, or an executing plan, and reserves each once', () => {
    const view = viewOf(
      running({
        nonces: {
          0: record(0, sent('n#run.1')),
          1: record(1, sent('k#run.2'), true),
          2: record(2, sent('recovery')),
          3: record(3, sent('m#run.5'))
        },
        plans: {
          'm#run.5': plan('m#run.5', 'executing', 3),
          'p#run.3': plan('p#run.3'),
          'q#run.4': plan('q#run.4', 'settled'),
          recovery: plan('recovery', 'executing', 2)
        }
      })
    )
    expect(['n', 'k', 'm', 'p', 'q'].map(key => isBusy(view, key))).toStrictEqual([
      true,
      true,
      true,
      true,
      false
    ])
    expect(view.busy).not.toContain('recovery')
    expect(view.numReservations).toBe(4)
    expect(view.acceptingNewWork).toBe(true)
  })

  it('reserves a recovery plan bidding at a recorded nonce only through that nonce', () => {
    const recovering = (targetNonce: number) =>
      ({
        ...plan('recovery:fill'),
        recovery: { kind: 'fill' },
        terms: { nonce: targetNonce, generation: 0 },
        cursor: 0
      }) as Plan
    const view = (targetNonce: number) =>
      viewOf(
        running({
          nonces: { 0: record(0, sent('n#run.1')) },
          plans: { 'recovery:fill': recovering(targetNonce) }
        })
      ).numReservations
    expect(view(0)).toBe(1)
    expect(view(5)).toBe(2)
  })

  it("reserves a plan's next transaction once its earlier one resolves, until and after finality", () => {
    const at = (cursor: number, resolved: boolean | 'pruned') =>
      viewOf(
        running({
          nonces: resolved === 'pruned' ? {} : { 0: record(0, sent('a#run.1'), resolved) },
          plans: { 'a#run.1': { ...plan('a#run.1', 'executing', 0), cursor } }
        })
      ).numReservations
    expect(at(0, false)).toBe(1)
    expect(at(1, true)).toBe(1)
    expect(at(1, 'pruned')).toBe(1)
  })

  it('reports how long the oldest nonce has waited, and the fee a nonce at the ceiling signed', () => {
    const bid = (hash: string, fee: bigint, kind: Candidate['kind'], sent: Candidate['sent']) =>
      ({ intentId: 'recovery:fill:0:1', hash, kind, sent, maxFeePerGas: fee }) as Candidate
    const waiting: NonceRecord = {
      ...record(4, bid('0xa', 5n, 'step', 'accepted')),
      openedAt: 1_000
    }
    waiting.candidates.push(bid('0xb', 9n, 'fill', 'rejected'), bid('0xc', 12n, 'fill', 'withheld'))
    const capped = (cap: boolean) =>
      ({
        ...plan('recovery:fill:0:1'),
        recovery: { kind: 'fill' },
        terms: { nonce: 4, generation: 0, ...(cap && { capped: true }) }
      }) as Plan
    const view = (cap: boolean) =>
      viewOf(
        running({
          now: 5_000,
          nonces: { 4: waiting, 5: { ...record(5, sent('m#run.1')), openedAt: 3_000 } },
          plans: { 'recovery:fill:0:1': capped(cap) }
        })
      )
    expect(view(true)).toMatchObject({
      oldestPendingMs: 4_000,
      pendingAtCeiling: 1,
      waitingMaxFeePerGas: 9n
    })
    expect(view(false)).toMatchObject({ pendingAtCeiling: 0 })
    expect(view(false)).not.toHaveProperty('waitingMaxFeePerGas')
    expect(viewOf(running({}))).toMatchObject({ oldestPendingMs: 0, pendingAtCeiling: 0 })
  })

  it('accepts new work only while running and not latched on an unresolved send', () => {
    expect(
      viewOf(running({ nonces: { 0: record(0, sent('m#run.1', 'unknown')) } })).acceptingNewWork
    ).toBe(false)
    expect(
      viewOf(running({ nonces: { 0: record(0, sent('m#run.1', 'unknown'), true) } }))
        .acceptingNewWork
    ).toBe(true)
    expect(
      viewOf(running({ lifecycle: { kind: 'idle' } as KernelState['lifecycle'] })).acceptingNewWork
    ).toBe(false)
  })
})
