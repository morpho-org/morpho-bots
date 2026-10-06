import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { getAddress } from 'viem'
import { describe, expect, test, vi } from 'vitest'

import type {
  LadderBookSideCrossing,
  LadderQuoteSet,
  ValidLadderConfig
} from '../../../src/domain/ladder'
import type { ExposureSnapshotReader } from '../../../src/infrastructure/exposure/exposure-snapshot.utils'
import type { LadderOfferTransport } from '../../../src/infrastructure/ladder/ladder-make.service'

import { LadderOwnershipCleanupError } from '../../../src/application/ladder/ladder-ownership-cleanup.error'
import { validateLadderConfig } from '../../../src/domain/ladder'
import { admitExposureCandidate } from '../../../src/infrastructure/exposure/exposure-admission.utils'
import { readExposureSnapshot } from '../../../src/infrastructure/exposure/exposure-snapshot.utils'
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
const cancellation = { txHash: cancellationHash, blockNumber: 1n }
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
      { groupId: oldGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: true },
      { groupId: secondGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: true }
    ],
    listOwnedBuyGroups: async () => [],
    readGroupConsumed: async () => 0n,
    listActiveGroupIds: async selected => (selected ? [oldGroup] : [oldGroup, secondGroup]),
    listBookOffers: async () => [],
    assessBook: assessment(),
    preparePublication: async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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
    admitPublication: async () => ({ admitted: true as const, capacityAssets: 0n }),
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
        groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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

  test('withdraws the ladder when nothing in the desired quote is publishable', async () => {
    const subject = harness()
    subject.transport.preparePublication = async () => undefined

    const result = await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(subject.events).toEqual([`cancel:${oldGroup}`, `forget:${oldGroup}`])
    expect(result).toMatchObject({ withdrawnSides: ['lower', 'higher'] })
  })

  test('reserves and admits only the sides a publication keeps', async () => {
    const subject = harness()
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'higher', rungIndexes: [0], ticks: [100n] }],
      bookClearedRungs: { lower: 0, higher: 0 },
      prospective: [{ marketId, buy: true, tick: 10n }],
      withdrawnSides: ['lower'],
      publish: async () => undefined
    })
    const reserved: LadderQuoteSet[] = []
    subject.transport.reservePublication = async publication => {
      reserved.push(publication.quote)
    }
    const admitted: LadderQuoteSet[] = []
    subject.transport.admitPublication = async candidate => {
      admitted.push(candidate.quote)
      return { admitted: true as const, capacityAssets: 0n }
    }

    const result = await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(result).toMatchObject({ withdrawnSides: ['lower'] })
    expect(reserved).toEqual([{ ...quote, lower: [] }])
    expect(admitted).toEqual([{ ...quote, lower: [] }])
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
      return cancellation
    }
    subject.transport.preparePublication = async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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
    subject.transport.listOwnedGroups = async () => [
      { groupId: oldGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: true }
    ]
    subject.transport.listActiveGroupIds = async () => [oldGroup]
    subject.transport.invalidate = async () => {
      invalidations += 1
      return cancellation
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
    subject.transport.invalidate = async () => cancellation
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
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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
      [...tracked].map(groupId => ({
        groupId,
        cap: { kind: 'units' as const, maximum: 10n },
        buy: true
      }))
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
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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
      return cancellation
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(batches).toEqual([[oldGroup, secondGroup]])
    expect(subject.events).toContain(`forget:${oldGroup},${secondGroup}`)
  })

  test('cleanup forgets filled owned sells without including them in the batch', async () => {
    const subject = harness()
    subject.transport.listOwnedGroups = async () => [
      { groupId: oldGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: true },
      { groupId: secondGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: false }
    ]
    subject.transport.readGroupConsumed = async groupId => (groupId === secondGroup ? 10n : 0n)
    subject.transport.invalidateBatch = async groupIds => {
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      return cancellation
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

  test('cleanup cancels a cash-capped buy that is fully consumed but still takeable', async () => {
    const subject = harness()
    subject.transport.listOwnedGroups = async () => [
      { groupId: oldGroup, cap: { kind: 'assets' as const, maximum: 10n }, buy: true },
      { groupId: secondGroup, cap: { kind: 'assets' as const, maximum: 10n }, buy: false }
    ]
    subject.transport.readGroupConsumed = async () => 10n
    subject.transport.invalidateBatch = async groupIds => {
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      return cancellation
    }

    await subject.service.cleanup()

    expect(subject.events).toEqual([
      `forget:${secondGroup}`,
      `cancel-batch:${oldGroup}`,
      `forget:${oldGroup}`
    ])
  })

  test('cleanup accepts a sell that fills while its cancellation is attempted', async () => {
    const subject = harness()
    let consumedReadCount = 0
    subject.transport.listOwnedGroups = async () => [
      { groupId: oldGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: false }
    ]
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
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
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

  test('mutates nothing when the cross moved to a side the decision did not admit', async () => {
    const subject = harness()
    subject.transport.assessBook = assessment({ higher: { crossed: true, clearable: true } })
    subject.transport.preparePublication = async () => {
      throw new Error('preparation must not run')
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'book-crossed',
      bookCrossedSides: ['lower']
    })

    expect(result).toMatchObject({ reconciliation: { applied: false } })
    expect(subject.events).toEqual([])
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
        groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }],
        bookClearedRungs: { lower: 0, higher: 0 },
        prospective: [],
        publish: async () => undefined
      }
    }

    await subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })

    expect(subject.events.slice(0, 2)).toEqual(['assess', 'prepare'])
  })
})

describe('MidnightLadderMakeService exposure admission', () => {
  const buyQuote = (assets: bigint): LadderQuoteSet => ({
    ...quote,
    lower: [],
    higher: [{ index: 0, rateBps: 550n, assets }]
  })
  const buyPublication = () => ({
    groupIds: [newGroup],
    groups: [{ groupId: newGroup, side: 'higher' as const, rungIndexes: [0], ticks: [100n] }],
    bookClearedRungs: { lower: 0, higher: 0 },
    prospective: [],
    publish: async () => publicationHash
  })

  const fillingChain = (buyPricingConfig?: ValidLadderConfig) => {
    const chain = { head: 7n, credit: 0n, cash: 200n, oldConsumed: 0n }
    const reader: ExposureSnapshotReader = {
      readLatestBlock: async () => ({ number: chain.head, timestamp: 1_000n }),
      readPositions: async () => [{ marketId, credit: chain.credit, debt: 0n, lossFactor: 0n }],
      readCash: async () => ({ cashBalance: chain.cash, allowance: 1_000n }),
      readConsumed: async groupIds =>
        groupIds.map(groupId => (groupId === oldGroup ? chain.oldConsumed : 0n))
    }
    const admissions: (bigint | undefined)[] = []
    const admitPublication: LadderOfferTransport['admitPublication'] = async candidate => {
      admissions.push(candidate.minimumBlockNumber)
      const snapshot = await readExposureSnapshot({
        reader,
        indexedGroups: [
          {
            id: oldGroup,
            cap: { kind: 'assets', maximum: 100n },
            consumed: 0n,
            offers: [{ marketId, maker, buy: true, tick: 1n }]
          }
        ],
        durableReservations: [{ groupId: newGroup, marketIds: [marketId], maxUnits: 100n }],
        ...(candidate.minimumBlockNumber === undefined
          ? {}
          : { minimumBlockNumber: candidate.minimumBlockNumber }),
        adapterError: LadderAdapterError
      })
      return admitExposureCandidate({
        candidate: {
          marketId,
          groupIds: candidate.groupIds,
          buyAssets: candidate.quote.higher.reduce((sum, rung) => sum + rung.assets, 0n),
          accepted: { acceptedLossFactor: 0n, defaulted: true },
          limits: {
            kind: 'ladder',
            targetMarketExposureAssets: 100n,
            maximumTotalExposureAssets: 1_000n,
            ...(buyPricingConfig
              ? { buyPricing: { config: buyPricingConfig, quote: candidate.quote } }
              : {})
          }
        },
        snapshot,
        adapterError: LadderAdapterError
      })
    }
    return { chain, admissions, admitPublication }
  }

  test('withholds price-changed when a partial fill during cancellation raises the skew', async () => {
    const subject = harness()
    const skewConfig = validateLadderConfig({
      marketId,
      quotePremiumBps: 0n,
      spreadBps: 100n,
      stepBps: 50n,
      rungCount: 1,
      sizeSkewBps: 0n,
      lowerRateBudgetAssets: 10n,
      higherRateBudgetAssets: 10n,
      targetMarketExposureAssets: 100n,
      maximumTotalExposureAssets: 1_000n,
      minimumOfferAssets: 1n,
      groupMode: 'shared-rung',
      loopIntervalSeconds: 60,
      bookCrossedCooldownSeconds: 180,
      movementToleranceBps: 10n,
      minimumRateBps: 0n,
      maximumRateBps: 2_000n,
      inventorySkew: { unitsPerStep: 10n }
    })
    const { chain, admitPublication } = fillingChain(skewConfig)
    subject.transport.admitPublication = admitPublication
    subject.transport.preparePublication = async () => buyPublication()
    subject.transport.invalidate = async groupId => {
      subject.events.push(`cancel:${groupId}`)
      chain.credit += 10n
      chain.cash -= 10n
      chain.oldConsumed = MAX_OFFER_CAP
      return { txHash: cancellationHash, blockNumber: 7n }
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: { ...buyQuote(10n), higherSkewBps: 0n },
      reason: 'resize'
    })

    expect(result).toMatchObject({ publicationWithheld: { reason: 'price-changed' } })
    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'release'
    ])
  })

  test('withholds a replacement whose old buy filled while its cancellation landed', async () => {
    const subject = harness()
    const { chain, admissions, admitPublication } = fillingChain()
    subject.transport.admitPublication = admitPublication
    subject.transport.preparePublication = async () => buyPublication()
    subject.transport.invalidate = async groupId => {
      subject.events.push(`cancel:${groupId}`)
      chain.credit += 100n
      chain.cash -= 100n
      chain.oldConsumed = MAX_OFFER_CAP
      return { txHash: cancellationHash, blockNumber: 7n }
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: buyQuote(100n),
      reason: 'resize'
    })

    expect(result).toMatchObject({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }],
      publicationWithheld: { reason: 'capacity-changed' }
    })
    expect(admissions).toEqual([7n])
    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'release'
    ])
  })

  test('publishes the same replacement when the old buy did not fill', async () => {
    const subject = harness()
    const { chain, admitPublication } = fillingChain()
    subject.transport.admitPublication = admitPublication
    subject.transport.invalidate = async groupId => {
      subject.events.push(`cancel:${groupId}`)
      chain.oldConsumed = MAX_OFFER_CAP
      return { txHash: cancellationHash, blockNumber: 7n }
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: buyQuote(100n),
      reason: 'resize'
    })

    expect(result).not.toHaveProperty('publicationWithheld')
    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'publish',
      'confirm'
    ])
  })

  test('cancels replaced groups in one batch and admits against its receipt block', async () => {
    const subject = harness()
    const minimumBlocks: (bigint | undefined)[] = []
    const batches: (readonly Hex[])[] = []
    subject.transport.listActiveGroupIds = async () => [oldGroup, secondGroup]
    subject.transport.invalidate = async () => {
      throw new Error('replacement of several groups must be batched')
    }
    subject.transport.invalidateBatch = async groupIds => {
      batches.push(groupIds)
      return { txHash: cancellationHash, blockNumber: 9n }
    }
    subject.transport.admitPublication = async candidate => {
      minimumBlocks.push(candidate.minimumBlockNumber)
      expect(candidate.groupIds).toEqual([newGroup])
      return { admitted: true as const, capacityAssets: 0n }
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'recenter'
    })

    expect(batches).toEqual([[oldGroup, secondGroup]])
    expect(result.submittedTransactions[0]).toEqual({
      operation: 'cancel',
      txHash: cancellationHash
    })
    expect(minimumBlocks).toEqual([9n])
    expect(subject.events).toContain(`forget:${oldGroup},${secondGroup}`)
  })

  test('keeps every replaced group owned when the batched cancellation fails', async () => {
    const subject = harness()
    subject.transport.listActiveGroupIds = async () => [oldGroup, secondGroup]
    subject.transport.invalidateBatch = async groupIds => {
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      throw new LadderAdapterError('transaction-reverted')
    }

    await expect(
      subject.service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({ operation: 'transaction-reverted' })
    expect(subject.events).toEqual([
      'reserve',
      `cancel-batch:${oldGroup},${secondGroup}`,
      'release'
    ])
  })

  test('admits an initial publication at the latest block', async () => {
    const subject = harness()
    const minimumBlocks: (bigint | undefined)[] = []
    subject.transport.listActiveGroupIds = async () => []
    subject.transport.admitPublication = async candidate => {
      minimumBlocks.push(candidate.minimumBlockNumber)
      return { admitted: true as const, capacityAssets: 0n }
    }

    await subject.service.reconcile({ marketId, desired: quote, reason: 'publish' })

    expect(minimumBlocks).toEqual([undefined])
  })

  test('publishes reduce-only sells without an admission snapshot', async () => {
    const subject = harness()
    subject.transport.admitPublication = async () => {
      throw new Error('sells must not be admitted')
    }

    await subject.service.reconcile({
      marketId,
      desired: { ...quote, higher: [] },
      reason: 'recenter'
    })

    expect(subject.events).toContain('publish')
  })

  test('withholds a buy publication whose market loss factor moved after the cancellations', async () => {
    const subject = harness()
    subject.transport.invalidate = async groupId => {
      subject.events.push(`cancel:${groupId}`)
      return { txHash: cancellationHash, blockNumber: 7n }
    }
    subject.transport.admitPublication = async () => ({
      admitted: false,
      reason: 'loss-factor-mismatch' as const,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above' as const,
      capacityAssets: 0n as const
    })

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'recenter'
    })

    expect(result).toMatchObject({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }],
      publicationWithheld: {
        reason: 'loss-factor-mismatch',
        lossFactor: 6n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'above'
      }
    })
    expect(subject.events).not.toContain('publish')
    expect(subject.events.at(-1)).toBe('release')
  })

  test('withholds as snapshot-unavailable and releases when no snapshot can be read', async () => {
    const subject = harness()
    subject.transport.invalidate = async groupId => {
      subject.events.push(`cancel:${groupId}`)
      return { txHash: cancellationHash, blockNumber: 7n }
    }
    subject.transport.admitPublication = async () => {
      throw new LadderAdapterError('snapshot-unavailable')
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'recenter'
    })

    expect(result).toMatchObject({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }],
      publicationWithheld: { reason: 'snapshot-unavailable', errorName: 'LadderAdapterError' }
    })
    expect(subject.events).toEqual([
      'reserve',
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      'release'
    ])
  })

  test('fails with the confirmed cancellations when a withheld reservation cannot be released', async () => {
    const subject = harness()
    subject.transport.invalidate = async () => ({ txHash: cancellationHash, blockNumber: 7n })
    subject.transport.admitPublication = async () => ({
      admitted: false,
      reason: 'capacity-changed' as const,
      capacityAssets: 0n
    })
    subject.transport.releasePublication = async () => {
      throw new TypeError('reservation unavailable')
    }

    const error = await subject.service
      .reconcile({ marketId, desired: quote, reason: 'recenter' })
      .catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({
      operation: 'publication-reservation-cleanup',
      confirmedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(subject.events).not.toContain('publish')
  })

  test('returns a no-longer-clearable book-crossed request without admitting', async () => {
    const subject = harness()
    subject.transport.admitPublication = async () => {
      throw new Error('a rest must not be admitted')
    }

    const result = await subject.service.reconcile({
      marketId,
      desired: quote,
      reason: 'book-crossed',
      bookCrossedSides: ['higher']
    })

    expect(result).toMatchObject({ reconciliation: { applied: false } })
    expect(subject.events).toEqual([])
  })
})

describe('MidnightLadderMakeService buy cancellation', () => {
  const consumedGroup: Hex = `0x${'55'.repeat(32)}`
  const buySubject = () => {
    const subject = harness()
    const consumption = new Map<Hex, bigint>([
      [oldGroup, 4n],
      [consumedGroup, MAX_OFFER_CAP]
    ])
    subject.transport.listOwnedBuyGroups = async selected => {
      subject.events.push(`list-buys:${selected}`)
      return [
        { groupId: oldGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: true },
        { groupId: consumedGroup, cap: { kind: 'units' as const, maximum: 10n }, buy: true }
      ]
    }
    subject.transport.readGroupConsumed = async groupId => consumption.get(groupId) ?? 0n
    subject.transport.invalidateBatch = async groupIds => {
      subject.events.push(`cancel-batch:${groupIds.join(',')}`)
      return cancellation
    }
    const forbidden = (name: string) => async () => {
      throw new Error(`${name} must not be reached`)
    }
    subject.transport.listBookOffers = forbidden('book read')
    subject.transport.assessBook = forbidden('book assessment')
    subject.transport.preparePublication = forbidden('preparation')
    subject.transport.listOwnedGroups = forbidden('strategy-wide group listing')
    return subject
  }

  test('cancels only uncancelled buy groups of the market and forgets them after the receipt', async () => {
    const subject = buySubject()

    const result = await subject.service.cancelBuys({ marketId, reason: 'loss-factor-mismatch' })

    expect(result).toEqual({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(subject.events).toEqual([
      `list-buys:${marketId}`,
      `cancel-batch:${oldGroup}`,
      `forget:${oldGroup}`
    ])
  })

  test('cancels a buy consumed up to its persisted size, which stays takeable', async () => {
    const subject = buySubject()
    subject.transport.readGroupConsumed = async groupId =>
      groupId === oldGroup ? 10n : MAX_OFFER_CAP

    await subject.service.cancelBuys({ marketId, reason: 'loss-factor-mismatch' })

    expect(subject.events).toContain(`cancel-batch:${oldGroup}`)
  })

  test('submits nothing when no buy remains live, and never re-cancels a confirmed group', async () => {
    const subject = buySubject()
    await subject.service.cancelBuys({ marketId, reason: 'loss-factor-mismatch' })
    subject.events.length = 0

    expect(await subject.service.cancelBuys({ marketId, reason: 'guard-read-failed' })).toEqual({
      submittedTransactions: []
    })
    expect(subject.events).toEqual([`list-buys:${marketId}`])
  })

  test('keeps ownership when the cancellation receipt is not confirmed', async () => {
    const subject = buySubject()
    subject.transport.invalidateBatch = async () => {
      throw new LadderAdapterError('transaction-pending')
    }

    await expect(
      subject.service.cancelBuys({ marketId, reason: 'loss-factor-mismatch' })
    ).rejects.toMatchObject({ operation: 'transaction-pending' })
    expect(subject.events.some(event => event.startsWith('forget'))).toBe(false)
  })

  test('reports a confirmed cancellation whose ownership cannot be forgotten', async () => {
    const subject = buySubject()
    subject.transport.forgetGroups = async () => {
      throw new TypeError('state unavailable')
    }

    const error = await subject.service
      .cancelBuys({ marketId, reason: 'loss-factor-mismatch' })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(LadderOwnershipCleanupError)
    expect(error).toMatchObject({
      cleanupErrorName: 'TypeError',
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
  })

  test('waits behind an in-flight reconciliation in the mutation queue', async () => {
    const subject = buySubject()
    let release: (() => void) | undefined
    subject.transport.listActiveGroupIds = () =>
      new Promise(resolve => {
        subject.events.push('reconcile:start')
        release = () => resolve([])
      })

    const reconcile = subject.service.reconcile({ marketId, reason: 'market-read-failed' })
    const cancellation = subject.service.cancelBuys({ marketId, reason: 'loss-factor-mismatch' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(subject.events).toEqual(['reconcile:start'])
    release?.()
    await Promise.all([reconcile, cancellation])
    expect(subject.events[1]).toBe(`list-buys:${marketId}`)
  })
})
