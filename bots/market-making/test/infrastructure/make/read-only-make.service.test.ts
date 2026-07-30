import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { ReadOnlyBootstrapMakeService } from '../../../src/infrastructure/make/read-only-bootstrap-make.service'
import { ReadOnlyLadderMakeService } from '../../../src/infrastructure/make/read-only-ladder-make.service'

const marketId: Hex = `0x${'55'.repeat(32)}`

describe('read-only make adapters', () => {
  test('logs bootstrap offers and safety invalidations without a submission dependency', async () => {
    const lines: string[] = []
    const service = new ReadOnlyBootstrapMakeService(line => lines.push(line))

    expect(
      await service.reconcile({
        marketId,
        desiredOffer: {
          marketId,
          assets: 50n,
          rateBps: 450n,
          referenceObservationId: 'block:100'
        },
        reason: 'publish'
      })
    ).toBe('logged')
    expect(await service.hardHalt({ reason: 'bootstrap-decision-failed' })).toBe('logged')
    expect(await service.cleanup()).toBe('logged')

    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        event: 'readonly.make',
        workflow: 'bootstrap',
        operation: 'reconcile',
        request: {
          marketId,
          desiredOffer: {
            marketId,
            assets: '50',
            rateBps: '450',
            referenceObservationId: 'block:100'
          },
          reason: 'publish'
        }
      },
      {
        event: 'readonly.make',
        workflow: 'bootstrap',
        operation: 'hard-halt',
        request: { reason: 'bootstrap-decision-failed' }
      },
      {
        event: 'readonly.make',
        workflow: 'bootstrap',
        operation: 'cleanup',
        request: { reason: 'shutdown' }
      }
    ])
  })

  test('validates a read-only bootstrap reconcile before logging it', async () => {
    const lines: string[] = []
    const service = new ReadOnlyBootstrapMakeService(
      line => lines.push(line),
      async () => {
        throw new Error('negative spread')
      }
    )

    const error = await service.reconcile({ marketId, reason: 'publish' }).catch(value => value)

    expect(error).toBeInstanceOf(Error)
    expect(lines).toEqual([])
  })

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
      line => lines.push(line)
    )

    expect(await service.readActive(marketId)).toBe(active)
    expect(await service.reconcile({ marketId, desired: active, reason: 'recenter' })).toBe(
      'logged'
    )
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

  test('validates a read-only ladder reconcile before logging it', async () => {
    const lines: string[] = []
    const service = new ReadOnlyLadderMakeService(
      { readActive: async () => undefined },
      line => lines.push(line),
      async () => {
        throw new LadderAdapterError('negative-spread')
      }
    )

    const error = await service.reconcile({ marketId, reason: 'publish' }).catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(lines).toEqual([])
  })
})
