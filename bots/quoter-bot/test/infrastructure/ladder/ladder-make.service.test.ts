import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { getAddress } from 'viem'
import { describe, expect, test, vi } from 'vitest'

import type { LadderBookSideCrossing, LadderQuoteSet } from '../../../src/domain/ladder/ladder'
import type { LadderOfferTransport } from '../../../src/infrastructure/ladder/ladder-make.service'

import { LadderOwnershipCleanupError } from '../../../src/application/ladder/ladder-ownership-cleanup.error'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { LadderHardHaltError } from '../../../src/infrastructure/ladder/ladder-hard-halt.error'
import { MidnightLadderMakeService } from '../../../src/infrastructure/ladder/ladder-make.service'

const marketId: Hex = `0x${'11'.repeat(32)}`
const oldGroup: Hex = `0x${'22'.repeat(32)}`
const newGroup: Hex = `0x${'33'.repeat(32)}`
const secondGroup: Hex = `0x${'44'.repeat(32)}`
const maker: Address = getAddress(`0x${'ab'.repeat(20)}`)
const thirdParty: Address = getAddress(`0x${'cd'.repeat(20)}`)
const publicationHash: Hex = `0x${'aa'.repeat(32)}`
const ratificationHash: Hex = `0x${'dd'.repeat(32)}`
const cancellationHash: Hex = `0x${'bb'.repeat(32)}`
const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 450n, assets: 10n }],
  higher: [{ index: 0, rateBps: 550n, assets: 10n }]
}

const uncrossed: LadderBookSideCrossing = { crossed: false, clearable: true }
const observedMarket = { market: {} as IMarket, now: 1_000n }

const assessment =
  (
    crossing: Partial<Record<'lower' | 'higher', LadderBookSideCrossing>> = {},
    events?: string[]
  ): LadderOfferTransport['assessBook'] =>
  async () => {
    events?.push('assess')
    return {
      reconciliation: {
        preparedAtTimestamp: 1_000n,
        bookCrossing: {
          lower: crossing.lower ?? uncrossed,
          higher: crossing.higher ?? uncrossed
        }
      },
      observedMarket
    }
  }

const harness = () => {
  const events: string[] = []
  const transport: LadderOfferTransport = {
    readActive: async () => undefined,
    readActiveState: async () => ({ consumption: [] }),
    listOwnedGroups: async () => [
      { groupId: oldGroup, maxAssets: 10n },
      { groupId: secondGroup, maxAssets: 10n }
    ],
    readGroupConsumed: async () => 0n,
    listActiveGroupIds: async selected => (selected ? [oldGroup] : [oldGroup, secondGroup]),
    listBookOffers: async () => [],
    assessBook: assessment(),
    preparePublication: async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [
        { marketId, buy: true, tick: 10n },
        { marketId, buy: false, tick: 20n }
      ],
      publish: async () => {
        events.push('publish')
      }
    }),
    reservePublication: async () => {
      events.push('reserve')
    },
    confirmPublication: async () => {
      events.push('confirm')
    },
    releasePublication: async () => {
      events.push('release')
    },
    invalidate: async groupId => {
      events.push(`cancel:${groupId}`)
    },
    invalidateBatch: async groupIds => {
      events.push(`cancel-batch:${groupIds.join(',')}`)
    },
    forgetGroups: async groupIds => {
      events.push(`forget:${groupIds.join(',')}`)
    }
  }
  return { events, transport, service: new MidnightLadderMakeService(transport, maker) }
}

describe('MidnightLadderMakeService', () => {
  test('reads only the reconciled market book for spread validation', async () => {
    const subject = harness()
    let selectedMarket: Hex | undefined
    subject.transport.listBookOffers = async (market: Hex) => {
      selectedMarket = market
      return []
    }

    await subject.service.reconcile({ marketId, desired: quote, reason: 'publish' })

    expect(selectedMarket).toBe(marketId)
  })

  test('prepares and validates against one book snapshot and one replaced-group set', async () => {
    const subject = harness()
    const restingBid = { marketId, buy: true, tick: 5n }
    let bookReads = 0
    subject.transport.listBookOffers = async () => {
      bookReads += 1
      return [restingBid]
    }
    let observed: Parameters<LadderOfferTransport['preparePublication']>[1] | undefined
    subject.transport.preparePublication = async (_quote, seen) => {
      observed = seen
      return {
        groupIds: [newGroup],
        groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
        bookClearedRungs: { lower: 0, higher: 0 },
        prospective: [{ marketId, buy: false, tick: 20n }],
        publish: async () => undefined
      }
    }

    await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(bookReads).toBe(1)
    expect(observed?.book).toEqual([restingBid])
    expect([...(observed?.replacedGroupIds ?? [])]).toEqual([oldGroup])
  })

  test('does not read the book when there is nothing to publish', async () => {
    const subject = harness()
    let bookReads = 0
    subject.transport.listBookOffers = async () => {
      bookReads += 1
      return []
    }

    await subject.service.reconcile({ marketId, reason: 'recenter' })

    expect(bookReads).toBe(0)
    expect(subject.events).toContain(`cancel:${oldGroup}`)
  })
  test('reserves, cancels, publishes, and confirms one replacement in order', async () => {
    const subject = harness()

    await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'publish',
      'confirm'
    ])
  })

  test('does no protocol work for an unchanged ladder', async () => {
    const subject = harness()

    await subject.service.reconcile({ marketId, desired: quote, reason: 'rest' })

    expect(subject.events).toEqual([])
  })

  test('returns replacement hashes and emits each submission immediately', async () => {
    const subject = harness()
    const submitted: unknown[] = []
    subject.transport.invalidate = async (groupId, observer) => {
      await observer?.({ operation: 'cancel', txHash: cancellationHash })
      subject.events.push(`cancel:${groupId}`)
      return cancellationHash
    }
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [{ marketId, buy: true, tick: 10n }],
      publish: async observer => {
        await observer?.({ operation: 'ratify', txHash: ratificationHash })
        await observer?.({ operation: 'publish', txHash: publicationHash })
        subject.events.push('publish')
        return [
          { operation: 'ratify', txHash: ratificationHash },
          { operation: 'publish', txHash: publicationHash }
        ] as const
      }
    })

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'recenter',
      onTransactionSubmitted: transaction => {
        submitted.push(transaction)
      }
    })

    expect(result).toMatchObject({
      bookClearedRungs: { lower: 0, higher: 0 },
      submittedTransactions: [
        { operation: 'cancel', txHash: cancellationHash },
        { operation: 'ratify', txHash: ratificationHash },
        { operation: 'publish', txHash: publicationHash }
      ]
    })
    expect(submitted).toEqual([
      { operation: 'cancel', txHash: cancellationHash },
      { operation: 'ratify', txHash: ratificationHash },
      { operation: 'publish', txHash: publicationHash }
    ])
  })

  test('retains a confirmed cancel when ladder ownership cleanup fails', async () => {
    const subject = harness()
    let invalidations = 0
    subject.transport.listOwnedGroups = async () => [{ groupId: oldGroup, maxAssets: 10n }]
    subject.transport.listActiveGroupIds = async () => [oldGroup]
    subject.transport.invalidate = async () => {
      invalidations += 1
      return cancellationHash
    }
    subject.transport.forgetGroups = async () => {
      throw new TypeError('state unavailable')
    }

    const error = await subject.service
      .reconcile({ marketId, desired: quote, reason: 'recenter' })
      .catch(value => value)

    expect(error).toBeInstanceOf(LadderOwnershipCleanupError)
    expect(error).toMatchObject({
      groupId: oldGroup,
      cleanupErrorName: 'TypeError',
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(subject.events).toContain('release')
    expect(await subject.service.cleanup()).toEqual({ submittedTransactions: [] })
    expect(invalidations).toBe(1)
  })

  test('preserves ownership cleanup failure when publication rollback storage also fails', async () => {
    const subject = harness()
    subject.transport.invalidate = async () => cancellationHash
    subject.transport.forgetGroups = async () => {
      throw new TypeError('ownership unavailable')
    }
    subject.transport.releasePublication = async () => {
      throw new TypeError('reservation unavailable')
    }

    const error = await subject.service
      .reconcile({ marketId, desired: quote, reason: 'recenter' })
      .catch(value => value)

    expect(error).toBeInstanceOf(LadderOwnershipCleanupError)
    expect(error).toMatchObject({
      groupId: oldGroup,
      cleanupErrorName: 'TypeError',
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
  })

  test('preserves publication revert when reservation rollback storage also fails', async () => {
    const subject = harness()
    subject.transport.listActiveGroupIds = async () => []
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [],
      publish: async () => {
        throw new LadderAdapterError('transaction-reverted')
      }
    })
    subject.transport.releasePublication = async () => {
      throw new TypeError('reservation unavailable')
    }

    const error = await subject.service
      .reconcile({ marketId, desired: quote, reason: 'recenter' })
      .catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ operation: 'transaction-reverted' })
  })

  test('retains and cancels an approved Setter reservation after restart when publication fails', async () => {
    const subject = harness()
    const tracked = new Set<Hex>()
    const invalidated: Hex[] = []
    subject.transport.listActiveGroupIds = async () => []
    subject.transport.listOwnedGroups = async () =>
      [...tracked].map(groupId => ({ groupId, maxAssets: 10n }))
    subject.transport.reservePublication = async publication => {
      for (const group of publication.groups) tracked.add(group.groupId)
      subject.events.push('reserve')
    }
    subject.transport.releasePublication = async groupIds => {
      for (const groupId of groupIds) tracked.delete(groupId)
      subject.events.push('release')
    }
    subject.transport.forgetGroups = async groupIds => {
      for (const groupId of groupIds) tracked.delete(groupId)
    }
    subject.transport.invalidate = async groupId => {
      invalidated.push(groupId)
    }
    subject.transport.invalidateBatch = async groupIds => {
      invalidated.push(...groupIds)
    }
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [],
      publish: async () => {
        throw new LadderAdapterError('mempool-validation-after-ratification')
      }
    })

    await expect(
      subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({ operation: 'mempool-validation-after-ratification' })
    expect(subject.events).toEqual(['reserve'])
    expect([...tracked]).toEqual([newGroup])

    expect(await new MidnightLadderMakeService(subject.transport, maker).cleanup()).toEqual({
      submittedTransactions: []
    })
    expect(invalidated).toEqual([newGroup])
    expect([...tracked]).toEqual([])
  })

  test('excludes a previously canceled group while the book still reports its offers', async () => {
    const subject = harness()
    let activeReadCount = 0
    subject.transport.listActiveGroupIds = async () => {
      activeReadCount += 1
      return activeReadCount === 1 ? [oldGroup] : []
    }
    subject.transport.listBookOffers = async () => [
      { groupId: oldGroup, marketId, buy: false, tick: 10n }
    ]
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [{ marketId, buy: true, tick: 10n }],
      publish: async () => {
        subject.events.push('publish')
      }
    })

    await subject.service.reconcile({ marketId, reason: 'market-read-failed' })
    await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(subject.events).toEqual([
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'reserve',
      'publish',
      'confirm'
    ])
  })

  test('cleanup cancels every active group in one batched transaction', async () => {
    const subject = harness()
    const batches: (readonly Hex[])[] = []
    subject.transport.invalidateBatch = async (groupIds, observer) => {
      batches.push(groupIds)
      await observer?.({ operation: 'cancel', txHash: cancellationHash })
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      return cancellationHash
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(batches).toEqual([[oldGroup, secondGroup]])
    expect(subject.events).toContain(`forget:${oldGroup},${secondGroup}`)
  })

  test('cleanup forgets filled owned groups without including them in the batch', async () => {
    const subject = harness()
    subject.transport.readGroupConsumed = async groupId => (groupId === secondGroup ? 10n : 0n)
    subject.transport.invalidateBatch = async groupIds => {
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      return cancellationHash
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(subject.events).toEqual([
      `forget:${secondGroup}`,
      `cancel-batch:${oldGroup}`,
      `forget:${oldGroup}`
    ])
  })

  test('cleanup accepts a group that fills while its cancellation is attempted', async () => {
    const subject = harness()
    let consumedReadCount = 0
    subject.transport.listOwnedGroups = async () => [{ groupId: oldGroup, maxAssets: 10n }]
    subject.transport.readGroupConsumed = async () => {
      consumedReadCount += 1
      return consumedReadCount === 1 ? 0n : 10n
    }
    subject.transport.invalidateBatch = async () => {
      throw new TypeError('provider detail')
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({ submittedTransactions: [] })
    expect(subject.events).toEqual([`forget:${oldGroup}`])
  })

  test('reports every group of a failed batched hard-halt cancellation', async () => {
    const subject = harness()
    const invalidateBatch = vi.fn(async (groupIds: readonly Hex[]) => {
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      throw new TypeError('provider detail')
    })
    subject.transport.invalidateBatch = invalidateBatch

    const error = await subject.service
      .hardHalt({ reason: 'reference-read-failed' })
      .catch(value => value)

    expect(error).toBeInstanceOf(LadderHardHaltError)
    expect(invalidateBatch).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({
      failures: [
        { groupId: oldGroup, errorName: 'TypeError' },
        { groupId: secondGroup, errorName: 'TypeError' }
      ]
    })
  })

  test('publishes over a third-party bid crossing the prospective ladder sell', async () => {
    const subject = harness()
    subject.transport.listBookOffers = async () => [
      { marketId, maker: thirdParty, buy: true, tick: 30n }
    ]
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [{ marketId, maker, buy: false, tick: 20n }],
      publish: async () => {
        subject.events.push('publish')
      }
    })

    await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'publish',
      'confirm'
    ])
  })

  test('refuses to publish over an own bid crossing the prospective ladder sell', async () => {
    const subject = harness()
    subject.transport.listBookOffers = async () => [{ marketId, maker, buy: true, tick: 30n }]
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [{ marketId, maker, buy: false, tick: 20n }],
      publish: async () => {
        subject.events.push('publish')
      }
    })

    await expect(
      subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({ operation: 'negative-spread' })
    expect(subject.events).toEqual([])
  })

  test('mutates nothing when a book-crossed replacement finds no clearable cross left', async () => {
    const subject = harness()
    let prepared = 0
    subject.transport.preparePublication = async () => {
      prepared += 1
      throw new Error('preparation must not run')
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'book-crossed'
    })

    expect(result).toEqual({
      submittedTransactions: [],
      reconciliation: {
        preparedAtTimestamp: 1_000n,
        bookCrossing: {
          lower: { crossed: false, clearable: true },
          higher: { crossed: false, clearable: true }
        },
        applied: false
      }
    })
    expect(prepared).toBe(0)
    expect(subject.events).toEqual([])
  })

  test('replaces the whole ladder when the recheck confirms a clearable cross', async () => {
    const subject = harness()
    subject.transport.assessBook = assessment({ lower: { crossed: true, clearable: true } })

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'book-crossed'
    })

    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'publish',
      'confirm'
    ])
    expect(result).toMatchObject({ reconciliation: { applied: true } })
  })

  test('publishes a resize over an uncrossed book and still reports the recheck', async () => {
    const subject = harness()

    const result = await subject.service.reconcile({ marketId, desired: quote, reason: 'resize' })

    expect(subject.events).toContain('publish')
    expect(result).toMatchObject({ reconciliation: { applied: true } })
  })

  test('assesses the fresh book before preparing the publication it gates', async () => {
    const subject = harness()
    subject.transport.assessBook = assessment({}, subject.events)
    subject.transport.preparePublication = async () => {
      subject.events.push('prepare')
      return {
        groupIds: [newGroup],
        groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
        bookClearedRungs: { lower: 0, higher: 0 },
        prospective: [],
        publish: async () => undefined
      }
    }

    await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(subject.events.slice(0, 2)).toEqual(['assess', 'prepare'])
  })
})
