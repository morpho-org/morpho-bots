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
    ({ intentId, sent: status }) as Candidate
  const record = (nonce: number, candidate: Candidate, resolved = false): NonceRecord => ({
    nonce,
    candidates: [candidate],
    lastActionHead: 1,
    ...(resolved && { resolution: {} as NonceRecord['resolution'] })
  })
  const plan = (intentId: string, status: Plan['status'] = 'executing') =>
    ({ intentId, status }) as Plan
  const running = (overrides: Partial<KernelState>): KernelState => ({
    ...createKernel(config).initialState(),
    lifecycle: { kind: 'running' },
    ...overrides
  })

  it('holds a key busy on an unresolved send or an executing plan, and reserves each once', () => {
    const view = viewOf(
      running({
        nonces: {
          0: record(0, sent('n#run.1')),
          1: record(1, sent('k#run.2'), true),
          2: record(2, sent('recovery')),
          3: record(3, sent('m#run.5'))
        },
        plans: {
          'm#run.5': plan('m#run.5'),
          'p#run.3': plan('p#run.3'),
          'q#run.4': plan('q#run.4', 'settled'),
          recovery: plan('recovery')
        }
      })
    )
    expect(['n', 'k', 'm', 'p', 'q'].map(key => isBusy(view, key))).toStrictEqual([
      true,
      false,
      true,
      true,
      false
    ])
    expect(view.busy).not.toContain('recovery')
    expect(view.numReservations).toBe(4)
    expect(view.acceptingNewWork).toBe(true)
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
