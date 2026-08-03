import type { Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'
import type { LadderOfferTransport } from '../../../src/infrastructure/ladder/ladder-make.service'

import { LadderOwnershipCleanupError } from '../../../src/application/ladder/ladder-ownership-cleanup.error'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { LadderHardHaltError } from '../../../src/infrastructure/ladder/ladder-hard-halt.error'
import { MidnightLadderMakeService } from '../../../src/infrastructure/ladder/ladder-make.service'

const marketId: Hex = `0x${'11'.repeat(32)}`
const oldGroup: Hex = `0x${'22'.repeat(32)}`
const newGroup: Hex = `0x${'33'.repeat(32)}`
const secondGroup: Hex = `0x${'44'.repeat(32)}`
const publicationHash: Hex = `0x${'aa'.repeat(32)}`
const cancellationHash: Hex = `0x${'bb'.repeat(32)}`
const secondCancellationHash: Hex = `0x${'cc'.repeat(32)}`
const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 450n, assets: 10n }],
  higher: [{ index: 0, rateBps: 550n, assets: 10n }]
}

const harness = () => {
  const events: string[] = []
  const transport: LadderOfferTransport = {
    readActive: async () => undefined,
    listOwnedGroups: async () => [
      { groupId: oldGroup, maxAssets: 10n },
      { groupId: secondGroup, maxAssets: 10n }
    ],
    readGroupConsumed: async () => 0n,
    listActiveGroupIds: async selected => (selected ? [oldGroup] : [oldGroup, secondGroup]),
    listBookOffers: async () => [],
    preparePublication: async () => ({
      groupIds: [newGroup],
      groups: [{ groupId: newGroup, side: 'lower', rungIndexes: [0] }],
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
    forgetGroups: async groupIds => {
      events.push(`forget:${groupIds.join(',')}`)
    }
  }
  return { events, transport, service: new MidnightLadderMakeService(transport) }
}

describe('MidnightLadderMakeService', () => {
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
      prospective: [{ marketId, buy: true, tick: 10n }],
      publish: async observer => {
        await observer?.({ operation: 'publish', txHash: publicationHash })
        subject.events.push('publish')
        return publicationHash
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

    expect(result).toEqual({
      submittedTransactions: [
        { operation: 'cancel', txHash: cancellationHash },
        { operation: 'publish', txHash: publicationHash }
      ]
    })
    expect(submitted).toEqual([
      { operation: 'cancel', txHash: cancellationHash },
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

  test('cleanup attempts every active group and returns confirmed cancellation hashes', async () => {
    const subject = harness()
    subject.transport.invalidate = async (groupId, observer) => {
      const txHash = groupId === oldGroup ? cancellationHash : secondCancellationHash
      await observer?.({ operation: 'cancel', txHash })
      subject.events.push(`cancel:${groupId}`)
      return txHash
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({
      submittedTransactions: [
        { operation: 'cancel', txHash: cancellationHash },
        { operation: 'cancel', txHash: secondCancellationHash }
      ]
    })
    expect(subject.events).toContain(`forget:${oldGroup}`)
    expect(subject.events).toContain(`forget:${secondGroup}`)
  })

  test('cleanup forgets filled owned groups without submitting cancellation transactions', async () => {
    const subject = harness()
    subject.transport.readGroupConsumed = async groupId => (groupId === secondGroup ? 10n : 0n)
    subject.transport.invalidate = async groupId => {
      subject.events.push(`cancel:${groupId}`)
      return cancellationHash
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(subject.events).toEqual([
      `cancel:${oldGroup}`,
      `forget:${oldGroup}`,
      `forget:${secondGroup}`
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
    subject.transport.invalidate = async () => {
      throw new TypeError('provider detail')
    }

    const result = await subject.service.cleanup()

    expect(result).toEqual({ submittedTransactions: [] })
    expect(subject.events).toEqual([`forget:${oldGroup}`])
  })

  test('attempts every active group before reporting aggregate hard-halt failure', async () => {
    const subject = harness()
    const invalidate = mock(async (groupId: Hex) => {
      subject.events.push(`cancel:${groupId}`)
      if (groupId === oldGroup) throw new TypeError('provider detail')
    })
    subject.transport.invalidate = invalidate

    const error = await subject.service
      .hardHalt({ reason: 'reference-read-failed' })
      .catch(value => value)

    expect(error).toBeInstanceOf(LadderHardHaltError)
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(subject.events).toContain(`cancel:${secondGroup}`)
  })
})
