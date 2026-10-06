import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { ReadOnlyBootstrapMakeService } from '../../../src/infrastructure/bootstrap/bootstrap-make.read-only'

const marketId: Hex = `0x${'55'.repeat(32)}`

describe('ReadOnlyBootstrapMakeService', () => {
  test('logs bootstrap offers and safety invalidations without a submission dependency', async () => {
    const lines: string[] = []
    const service = new ReadOnlyBootstrapMakeService(line => {
      lines.push(line)
    })

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

  test('propagates rejected async writers from bootstrap halt and cleanup operations', async () => {
    const writeError = new Error('event sink unavailable')
    const service = new ReadOnlyBootstrapMakeService(async () => {
      throw writeError
    })

    await expect(service.hardHalt({ reason: 'bootstrap-decision-failed' })).rejects.toBe(writeError)
    await expect(service.cleanup()).rejects.toBe(writeError)
  })

  test('validates a read-only bootstrap reconcile before logging it', async () => {
    const lines: string[] = []
    const service = new ReadOnlyBootstrapMakeService(
      line => {
        lines.push(line)
      },
      async () => {
        throw new Error('negative spread')
      }
    )

    const error = await service.reconcile({ marketId, reason: 'publish' }).catch(value => value)

    expect(error).toBeInstanceOf(Error)
    expect(lines).toEqual([])
  })

  test('logs the same adjusted bootstrap offer returned by read-only validation', async () => {
    const lines: string[] = []
    const service = new ReadOnlyBootstrapMakeService(
      line => {
        lines.push(line)
      },
      async parameters => ({
        ...parameters,
        desiredOffer: parameters.desiredOffer
          ? { ...parameters.desiredOffer, assets: 60n, rateBps: 450n }
          : undefined
      })
    )

    await service.reconcile({
      marketId,
      desiredOffer: {
        marketId,
        assets: 100n,
        rateBps: 500n,
        referenceObservationId: 'block:100'
      },
      reason: 'publish'
    })

    expect(JSON.parse(lines[0]!)).toMatchObject({
      request: { desiredOffer: { assets: '60', rateBps: '450' } }
    })
  })
})
