import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder'

import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { ReadOnlyLadderMakeService } from '../../../src/infrastructure/ladder/ladder-make.read-only'

const marketId: Hex = `0x${'55'.repeat(32)}`

describe('ReadOnlyLadderMakeService', () => {
  test('reads active ladder roots but logs every requested mutation', async () => {
    const lines: string[] = []
    const reads: Hex[] = []
    const active: LadderQuoteSet = {
      marketId,
      centerRateBps: 500n,
      groupMode: 'shared-rung',
      lower: [{ index: 0, rateBps: 400n, assets: 10n }],
      higher: [{ index: 0, rateBps: 600n, assets: 10n }]
    }
    const service = new ReadOnlyLadderMakeService(
      {
        readActive: async id => {
          reads.push(id)
          return active
        }
      },
      line => {
        lines.push(line)
      }
    )

    expect(await service.readActive(marketId)).toBe(active)
    expect(await service.reconcile({ marketId, desired: active, reason: 'recenter' })).toEqual({
      submittedTransactions: [],
      logged: true
    })
    expect(await service.hardHalt({ reason: 'ladder-decision-failed' })).toBe('logged')

    expect(reads).toEqual([marketId])
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        event: 'readonly.make',
        workflow: 'ladder',
        operation: 'reconcile',
        request: {
          marketId,
          desired: {
            marketId,
            centerRateBps: '500',
            groupMode: 'shared-rung',
            lower: [{ index: 0, rateBps: '400', assets: '10' }],
            higher: [{ index: 0, rateBps: '600', assets: '10' }]
          },
          reason: 'recenter'
        }
      },
      {
        event: 'readonly.make',
        workflow: 'ladder',
        operation: 'hard-halt',
        request: { reason: 'ladder-decision-failed' }
      }
    ])
  })

  test('propagates rejected async writers from ladder halt and cleanup operations', async () => {
    const writeError = new Error('event sink unavailable')
    const service = new ReadOnlyLadderMakeService(
      { readActive: async () => undefined },
      async () => {
        throw writeError
      }
    )

    await expect(service.hardHalt({ reason: 'ladder-decision-failed' })).rejects.toBe(writeError)
    await expect(service.cleanup()).rejects.toBe(writeError)
  })

  test('validates a read-only ladder reconcile before logging it', async () => {
    const lines: string[] = []
    const service = new ReadOnlyLadderMakeService(
      { readActive: async () => undefined },
      line => {
        lines.push(line)
      },
      async () => {
        throw new LadderAdapterError('negative-spread')
      }
    )

    const error = await service.reconcile({ marketId, reason: 'publish' }).catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(lines).toEqual([])
  })

  test('returns the crossing recheck validation supplied beside the logged line', async () => {
    const lines: string[] = []
    const reconciliation = {
      preparedAtTimestamp: 1_000n,
      bookCrossing: {
        lower: { crossed: true, clearable: true },
        higher: { crossed: false, clearable: true }
      },
      applied: true
    }
    const service = new ReadOnlyLadderMakeService(
      { readActive: async () => undefined },
      line => {
        lines.push(line)
      },
      async () => ({ reconciliation, bookClearedRungs: { lower: 2, higher: 0 } })
    )

    expect(await service.reconcile({ marketId, reason: 'book-crossed' })).toEqual({
      submittedTransactions: [],
      logged: true,
      reconciliation,
      bookClearedRungs: { lower: 2, higher: 0 }
    })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'readonly.make',
      operation: 'reconcile',
      request: { reason: 'book-crossed' }
    })
  })

  test('logs nothing when the read-only recheck found no clearable cross left', async () => {
    const lines: string[] = []
    const reconciliation = {
      preparedAtTimestamp: 1_000n,
      bookCrossing: {
        lower: { crossed: false, clearable: true },
        higher: { crossed: false, clearable: true }
      },
      applied: false
    }
    const service = new ReadOnlyLadderMakeService(
      { readActive: async () => undefined },
      line => {
        lines.push(line)
      },
      async () => ({ reconciliation })
    )

    expect(await service.reconcile({ marketId, reason: 'book-crossed' })).toEqual({
      submittedTransactions: [],
      logged: true,
      reconciliation
    })
    expect(lines).toEqual([])
  })

  test('logs a buy cancellation instead of cancelling', async () => {
    const lines: string[] = []
    const service = new ReadOnlyLadderMakeService({ readActive: async () => undefined }, line => {
      lines.push(line)
    })

    expect(await service.cancelBuys({ marketId, reason: 'loss-factor-mismatch' })).toBe('logged')
    expect(lines.map(line => JSON.parse(line) as unknown)).toEqual([
      {
        event: 'readonly.make',
        workflow: 'ladder',
        operation: 'cancel-buys',
        request: { marketId, reason: 'loss-factor-mismatch' }
      }
    ])
  })
})
