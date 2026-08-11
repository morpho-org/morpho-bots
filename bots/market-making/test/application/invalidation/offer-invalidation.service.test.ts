import type { Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import type { OfferInvalidationPort } from '../../../src/application/invalidation/offer-invalidation.service'

import { OfferInvalidationFailedError } from '../../../src/application/invalidation/offer-invalidation-failed.error'
import { OfferInvalidationService } from '../../../src/application/invalidation/offer-invalidation.service'
import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'

const groupA: Hex = `0x${'11'.repeat(32)}`
const groupB: Hex = `0x${'22'.repeat(32)}`
const txA: Hex = `0x${'aa'.repeat(32)}`
const txB: Hex = `0x${'bb'.repeat(32)}`

const subject = (
  overrides: Partial<OfferInvalidationPort> = {},
  mode: 'write' | 'readonly' = 'write'
) => {
  const events: string[] = []
  const port: OfferInvalidationPort = {
    mode: () => mode,
    preflight: async () => {
      events.push('preflight')
    },
    listActiveGroupIds: async () => {
      events.push('list')
      return [groupA, groupA, groupB]
    },
    invalidate: async (groupId, observer) => {
      events.push(`invalidate:${groupId}`)
      const txHash = groupId === groupA ? txA : txB
      await observer?.(txHash)
      return txHash
    },
    invalidateBatch: async (groupIds, observer) => {
      events.push(`invalidateBatch:${groupIds.join(',')}`)
      await observer?.(txA)
      return txA
    },
    forgetGroups: async ([groupId]) => {
      events.push(`forget:${groupId}`)
    },
    ...overrides
  }

  return { service: new OfferInvalidationService(port), port, events }
}

describe('OfferInvalidationService', () => {
  test('uses the mandatory batch capability once for maker-wide read-only rendering', async () => {
    const invalidateBatch = vi.fn(async () => undefined)
    const invalidate = vi.fn(async () => txB)
    const { service } = subject({ invalidateBatch, invalidate }, 'readonly')

    const report = await service.run()

    expect(report).toEqual({
      status: 'logged',
      scope: 'all',
      matchedGroups: 2,
      invalidatedGroups: [{ groupId: groupA }, { groupId: groupB }]
    })
    expect(invalidateBatch).toHaveBeenCalledTimes(1)
    expect(invalidateBatch).toHaveBeenCalledWith([groupA, groupB], expect.any(Function))
    expect(invalidate).not.toHaveBeenCalled()
  })

  test('reports one confirmed batch hash for every selected group and forgets them together', async () => {
    const invalidateBatch = vi.fn(
      async (groupIds: readonly Hex[], observer?: (hash: Hex) => unknown) => {
        expect(groupIds).toEqual([groupA, groupB])
        await observer?.(txA)
        return txA
      }
    )
    const invalidate = vi.fn(async () => txB)
    const forgetGroups = vi.fn(async () => undefined)
    const { service } = subject({ invalidateBatch, invalidate, forgetGroups })
    const submitted: unknown[] = []

    const report = await service.run({
      onTransactionSubmitted: event => {
        submitted.push(event)
      }
    })

    expect(report.invalidatedGroups).toEqual([
      { groupId: groupA, txHash: txA },
      { groupId: groupB, txHash: txA }
    ])
    expect(submitted).toEqual([
      { event: 'offer-invalidation.transaction-submitted', groupId: groupA, txHash: txA },
      { event: 'offer-invalidation.transaction-submitted', groupId: groupB, txHash: txA }
    ])
    expect(invalidate).not.toHaveBeenCalled()
    expect(forgetGroups).toHaveBeenCalledWith([groupA, groupB])
  })

  test('does not fall back after a submitted batch transaction fails', async () => {
    const invalidate = vi.fn(async () => txB)
    const { service } = subject({
      invalidateBatch: async (_groupIds, observer) => {
        await observer?.(txA)
        throw new OfferInvalidationAdapterError('transaction-reverted')
      },
      invalidate
    })

    const error = await service.run().catch(value => value)

    expect(invalidate).not.toHaveBeenCalled()
    expect(error).toMatchObject({
      report: {
        invalidatedGroups: [],
        failures: [
          { stage: 'invalidation', groupId: groupA, txHash: txA },
          { stage: 'invalidation', groupId: groupB, txHash: txA }
        ]
      }
    })
  })

  test('retains the shared batch hash for every group when ownership cleanup fails', async () => {
    const forgetGroups = vi.fn(async () => {
      throw new OfferInvalidationAdapterError('ownership-cleanup')
    })
    const { service } = subject({
      invalidateBatch: async (_groupIds, observer) => {
        await observer?.(txA)
        return txA
      },
      forgetGroups
    })

    const error = await service.run().catch(value => value)

    expect(error).toBeInstanceOf(OfferInvalidationFailedError)
    expect(error).toMatchObject({
      report: {
        status: 'failed',
        matchedGroups: 2,
        invalidatedGroups: [
          { groupId: groupA, txHash: txA },
          { groupId: groupB, txHash: txA }
        ],
        failures: [
          {
            stage: 'ownership-cleanup',
            groupId: groupA,
            errorName: 'OfferInvalidationAdapterError',
            txHash: txA
          },
          {
            stage: 'ownership-cleanup',
            groupId: groupB,
            errorName: 'OfferInvalidationAdapterError',
            txHash: txA
          }
        ]
      }
    })
    expect(forgetGroups).toHaveBeenCalledTimes(1)
    expect(forgetGroups).toHaveBeenCalledWith([groupA, groupB])
  })

  test('directly invalidates an explicit group without consulting the active-group API', async () => {
    const listActiveGroupIds = vi.fn(async () => [groupB])
    const invalidateBatch = vi.fn(async () => txB)
    const { service } = subject({ listActiveGroupIds, invalidateBatch })

    const report = await service.run({ groupId: groupA })

    expect(report).toMatchObject({
      status: 'applied',
      scope: 'group',
      matchedGroups: 1,
      invalidatedGroups: [{ groupId: groupA, txHash: txA }]
    })
    expect(listActiveGroupIds).not.toHaveBeenCalled()
    expect(invalidateBatch).not.toHaveBeenCalled()
  })

  test('renders selected groups without hashes in read-only mode', async () => {
    const { service } = subject(
      {
        listActiveGroupIds: async () => [groupA],
        invalidateBatch: async () => undefined,
        invalidate: async () => undefined
      },
      'readonly'
    )

    expect(await service.run()).toEqual({
      status: 'logged',
      scope: 'all',
      matchedGroups: 1,
      invalidatedGroups: [{ groupId: groupA }]
    })
  })

  test('preserves a submitted hash when explicit group invalidation fails', async () => {
    const { service, port } = subject()
    port.invalidate = async (_groupId, observer) => {
      await observer?.(txA)
      throw new OfferInvalidationAdapterError('receipt')
    }

    const error = await service.run({ groupId: groupA }).catch(value => value)

    expect(error).toBeInstanceOf(OfferInvalidationFailedError)
    expect(error).toMatchObject({
      report: {
        status: 'failed',
        scope: 'group',
        matchedGroups: 1,
        invalidatedGroups: [],
        failures: [
          {
            stage: 'invalidation',
            groupId: groupA,
            errorName: 'OfferInvalidationAdapterError',
            txHash: txA
          }
        ]
      }
    })
  })

  test('retains a confirmed invalidation when ownership cleanup fails', async () => {
    const { service } = subject({
      listActiveGroupIds: async () => [groupA],
      forgetGroups: async () => {
        throw new OfferInvalidationAdapterError('ownership-cleanup')
      }
    })

    const error = await service.run({ groupId: groupA }).catch(value => value)

    expect(error).toBeInstanceOf(OfferInvalidationFailedError)
    expect(error).toMatchObject({
      report: {
        status: 'failed',
        matchedGroups: 1,
        invalidatedGroups: [{ groupId: groupA, txHash: txA }],
        failures: [
          {
            stage: 'ownership-cleanup',
            groupId: groupA,
            errorName: 'OfferInvalidationAdapterError',
            txHash: txA
          }
        ]
      }
    })
  })

  test('reports preflight failure without enumerating or invalidating groups', async () => {
    const listActiveGroupIds = vi.fn(async () => [groupA])
    const invalidate = vi.fn(async () => txA)
    const { service } = subject({
      preflight: async () => {
        throw new OfferInvalidationAdapterError('preflight')
      },
      listActiveGroupIds,
      invalidate
    })

    const error = await service.run().catch(value => value)

    expect(error).toMatchObject({
      report: {
        status: 'failed',
        scope: 'all',
        matchedGroups: 0,
        failures: [{ stage: 'preflight', errorName: 'OfferInvalidationAdapterError' }]
      }
    })
    expect(listActiveGroupIds).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })
})
