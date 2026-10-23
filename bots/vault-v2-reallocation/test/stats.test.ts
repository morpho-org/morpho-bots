import type { KeyedWrite } from '@repo/engine'

import { TX_SCENARIO } from '@repo/kit/testing'
import { describe, expect, it } from 'vitest'

import type { VaultReading } from '../src/reallocation'
import type { TickInput, TickState } from '../src/stats'

import { countTick, NO_TICK } from '../src/stats'

const fold = (inputs: readonly TickInput[], state: TickState = NO_TICK) =>
  inputs.reduce((current, input) => countTick(current, input).state, state)

const read = (write: KeyedWrite<VaultReading>) => ({ from: 'world', value: write }) as const

describe('countTick', () => {
  it("counts each step's first broadcast at a nonce, as the tx reporter did", () => {
    const state = fold(TX_SCENARIO.map(value => ({ from: 'activity', value }) as const))
    expect(state.counts.broadcast).toBe(5)
  })

  it('counts simulation reverts, dry runs and errors by the reason a preparation declined', () => {
    const state = fold(
      ['reverted', 'dry_run', 'dry_run', 'error', 'balanced'].map(
        reason => ({ from: 'prepared', value: { ok: false, reason } }) as const
      )
    )
    expect(state.counts).toStrictEqual({ sim_reverts: 1, dry_runs: 2, broadcast: 0, errors: 1 })
  })

  it('emits the counts with each read, at its block, and starts the next count', () => {
    const counted = fold([{ from: 'prepared', value: { ok: false, reason: 'error' } }])
    const write = {
      coverage: 'complete',
      entries: {},
      basis: { block: 12, blockHash: '0x' }
    } as const
    const { state, tick } = countTick(counted, read(write))
    expect(tick).toStrictEqual({ write, block: 12, counts: { ...NO_TICK.counts, errors: 1 } })
    expect(state.counts).toStrictEqual(NO_TICK.counts)
  })

  it('reports a failed read at the newest head, since its write names no block', () => {
    const atHead = fold([{ from: 'head', value: { number: 40, hash: '0x' } as never }])
    expect(countTick(atHead, read({ coverage: 'failed', reason: 'lens' })).tick?.block).toBe(40)
  })
})
