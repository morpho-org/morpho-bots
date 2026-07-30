import type { Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'
import type { LadderOfferTransport } from '../../../src/infrastructure/ladder/ladder-make.service'

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
