import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type { BootstrapSubmittedTransaction } from '../../../src/application/bootstrap/position-bootstrap-verbose'

import { BootstrapOwnershipCleanupError } from '../../../src/application/bootstrap/bootstrap-ownership-cleanup.error'
import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapHardHaltError } from '../../../src/infrastructure/bootstrap/bootstrap-hard-halt.error'
import { MidnightBootstrapMakeService } from '../../../src/infrastructure/bootstrap/bootstrap-make.service'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`
const publishedGroupId: Hex = `0x${'33'.repeat(32)}`
const cancellationHash: Hex = `0x${'aa'.repeat(32)}`
const publicationHash: Hex = `0x${'bb'.repeat(32)}`
const desiredOffer = {
  marketId,
  assets: 100n,
  rateBps: 500n,
  referenceObservationId: 'test'
}

describe('MidnightBootstrapMakeService', () => {
  test('never publishes a prospective buy that crosses the current whole book', async () => {
    let published = false
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => [{ marketId, buy: false, tick: 100n }],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          published = true
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => {}
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'publish' })
      .catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'negative-spread' })
    expect(published).toBe(false)
  })

  test('reloads the whole book immediately before publishing a safe offer', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => {
        events.push('book')
        return [{ marketId, buy: false, tick: 101n }]
      },
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => {}
    })

    await service.reconcile({ marketId, desiredOffer, reason: 'publish' })

    expect(events).toEqual(['book', 'publish'])
  })

  test('returns confirmed cancellation and publication hashes in submission order', async () => {
    const submitted: BootstrapSubmittedTransaction[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 400n }],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async observer => {
          await observer?.({ operation: 'publish', txHash: publicationHash })
          return publicationHash
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async (_group, observer) => {
        await observer?.({ operation: 'cancel', txHash: cancellationHash })
        return cancellationHash
      }
    })

    expect(
      await service.reconcile({
        marketId,
        desiredOffer,
        reason: 'replace',
        onTransactionSubmitted: transaction => {
          submitted.push(transaction)
        }
      })
    ).toEqual({
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

  test('retains a confirmed cancel when bootstrap ownership cleanup fails', async () => {
    let invalidations = 0
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 400n }],
      listOwnedGroupIds: async () => [groupId],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId: publishedGroupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => {
        invalidations += 1
        return cancellationHash
      },
      forgetGroups: async () => {
        throw new BootstrapAdapterError('group-ownership-state')
      }
    })

    const error = await service
      .reconcile({ marketId, reason: 'target-reached' })
      .catch(value => value)

    expect(error).toBeInstanceOf(BootstrapOwnershipCleanupError)
    expect(error).toMatchObject({
      groupId,
      cleanupErrorName: 'BootstrapAdapterError',
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(await service.hardHalt({ reason: 'market-invalidation-failed' })).toEqual({
      submittedTransactions: []
    })
    expect(invalidations).toBe(1)
  })

  test('does not interrupt receipt handling when the submission observer fails', async () => {
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async observer => {
          await observer?.({ operation: 'publish', txHash: publicationHash })
          return publicationHash
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => cancellationHash
    })

    expect(
      await service.reconcile({
        marketId,
        desiredOffer,
        reason: 'publish',
        onTransactionSubmitted: () => {
          throw new Error('terminal unavailable')
        }
      })
    ).toEqual({
      submittedTransactions: [{ operation: 'publish', txHash: publicationHash }]
    })
  })

  test('returns confirmed cancellation hashes from graceful cleanup', async () => {
    const forgotten: Hex[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listOwnedGroupIds: async () => [groupId],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId, publish: async () => publicationHash }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      forgetGroups: async (groupIds: readonly Hex[]) => {
        forgotten.push(...groupIds)
      },
      invalidate: async () => cancellationHash
    })

    expect(await service.cleanup()).toEqual({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    })
    expect(forgotten).toEqual([groupId])
  })

  test('persists a published group for ownership after a process restart', async () => {
    const owned = new Set<Hex>()
    const invalidated: Hex[] = []
    const transport = {
      listActiveGroups: async () =>
        owned.has(publishedGroupId)
          ? [{ id: publishedGroupId, marketId, assets: 100n, rateBps: 500n }]
          : [],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId: publishedGroupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async (id: Hex) => {
        owned.add(id)
      },
      releaseGroupReservation: async () => {},
      forgetGroups: async (groupIds: readonly Hex[]) => {
        for (const id of groupIds) owned.delete(id)
      },
      invalidate: async (id: Hex) => {
        invalidated.push(id)
      }
    }

    await new MidnightBootstrapMakeService(transport).reconcile({
      marketId,
      desiredOffer,
      reason: 'publish'
    })
    await new MidnightBootstrapMakeService(transport).reconcile({
      marketId,
      reason: 'target-reached'
    })

    expect([...owned]).toEqual([])
    expect(invalidated).toEqual([publishedGroupId])
  })

  test('does not publish when durable reservation fails', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
        }
      }),
      reserveGroup: async () => {
        events.push('reserve')
        throw new BootstrapAdapterError('group-ownership-state')
      },
      confirmPublishedGroup: async () => {
        events.push('confirm')
      },
      releaseGroupReservation: async () => {
        events.push('release')
      },
      invalidate: async () => {}
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'publish' })
      .catch(value => value)

    expect(error).toMatchObject({ operation: 'group-ownership-state' })
    expect(events).toEqual(['reserve'])
  })

  test('cleans the durable reservation when publication fails', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
          throw new BootstrapAdapterError('transaction-reverted')
        }
      }),
      reserveGroup: async () => {
        events.push('reserve')
      },
      confirmPublishedGroup: async () => {
        events.push('confirm')
      },
      releaseGroupReservation: async () => {
        events.push('release')
      },
      invalidate: async () => {}
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'publish' })
      .catch(value => value)

    expect(error).toMatchObject({ operation: 'transaction-reverted' })
    expect(events).toEqual(['reserve', 'publish', 'release'])
  })

  test('retains the durable reservation when publication outcome is ambiguous', async () => {
    const tracked = new Set<Hex>()
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
          throw new Error('receipt unavailable')
        }
      }),
      reserveGroup: async id => {
        tracked.add(id)
        events.push('reserve')
      },
      confirmPublishedGroup: async () => {
        events.push('confirm')
      },
      releaseGroupReservation: async id => {
        tracked.delete(id)
        events.push('release')
      },
      invalidate: async () => {}
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'publish' })
      .catch(value => value)

    expect(error).toBeInstanceOf(Error)
    expect(events).toEqual(['reserve', 'publish'])
    expect([...tracked]).toEqual([publishedGroupId])
  })

  test('keeps a published group tracked when finalization fails', async () => {
    const tracked = new Set<Hex>()
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
        }
      }),
      reserveGroup: async id => {
        tracked.add(id)
        events.push('reserve')
      },
      confirmPublishedGroup: async () => {
        events.push('confirm')
        throw new BootstrapAdapterError('group-ownership-state')
      },
      releaseGroupReservation: async id => {
        tracked.delete(id)
        events.push('release')
      },
      invalidate: async () => {}
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'publish' })
      .catch(value => value)

    expect(error).toMatchObject({ operation: 'group-ownership-state' })
    expect(events).toEqual(['reserve', 'publish', 'confirm'])
    expect([...tracked]).toEqual([publishedGroupId])
  })

  test('excludes groups being replaced from prospective spread validation', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 500n }],
      listBookOffers: async () => [
        { groupId, marketId, buy: true, tick: 101n },
        { marketId, buy: false, tick: 100n }
      ],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 99n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => {
        events.push('invalidate')
      }
    })

    await service.reconcile({ marketId, desiredOffer, reason: 'replace' })

    expect(events).toEqual(['invalidate', 'publish'])
  })

  test('excludes a previously canceled group while the book still reports its offers', async () => {
    let activeReadCount = 0
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => {
        activeReadCount += 1
        return activeReadCount === 1 ? [{ id: groupId, marketId, assets: 100n, rateBps: 500n }] : []
      },
      listBookOffers: async () => [{ groupId, marketId, buy: false, tick: 100n }],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      forgetGroups: async () => {},
      invalidate: async () => {
        events.push('invalidate')
      }
    })

    await service.reconcile({ marketId, reason: 'target-reached' })
    await service.reconcile({ marketId, desiredOffer, reason: 'publish' })

    expect(events).toEqual(['invalidate', 'publish'])
  })

  test('prepares and reserves a replacement before invalidation and releases it if invalidation fails', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 500n }],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => {
        events.push('prepare')
        return {
          groupId: publishedGroupId,
          publish: async () => {
            events.push('publish')
          }
        }
      },
      reserveGroup: async () => {
        events.push('reserve')
      },
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {
        events.push('release')
      },
      invalidate: async () => {
        events.push('invalidate')
        throw new BootstrapAdapterError('transaction-reverted')
      }
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'replace' })
      .catch(value => value)

    expect(error).toMatchObject({ operation: 'transaction-reverted' })
    expect(events).toEqual(['prepare', 'reserve', 'invalidate', 'release'])
  })

  test('preserves invalidation failure when reservation rollback storage also fails', async () => {
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 500n }],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId: publishedGroupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {
        throw new BootstrapAdapterError('group-ownership-state')
      },
      invalidate: async () => {
        throw new BootstrapAdapterError('transaction-reverted')
      }
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'replace' })
      .catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'transaction-reverted' })
  })

  test('validates a replacement spread before invalidating its live group', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 500n }],
      listBookOffers: async () => [{ marketId, buy: false, tick: 100n }],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish')
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => {
        events.push('invalidate')
      }
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'replace' })
      .catch(value => value)

    expect(error).toMatchObject({ operation: 'negative-spread' })
    expect(events).toEqual([])
  })

  test('refuses market-local replacement of a group shared with another market', async () => {
    const secondMarketId: Hex = `0x${'44'.repeat(32)}`
    const events: string[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [
        { id: groupId, marketId, assets: 100n, rateBps: 500n },
        { id: groupId, marketId: secondMarketId, assets: 100n, rateBps: 600n }
      ],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId: publishedGroupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async () => {
        events.push('invalidate')
      }
    })

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'replace' })
      .catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'shared-group-reconciliation' })
    expect(events).toEqual([])
  })

  test('cancels a shared multi-market group only once during a hard halt', async () => {
    const secondMarketId: Hex = `0x${'44'.repeat(32)}`
    const attempted: Hex[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [
        { id: groupId, marketId, assets: 100n, rateBps: 500n },
        { id: groupId, marketId: secondMarketId, assets: 100n, rateBps: 600n }
      ],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async id => {
        attempted.push(id)
      }
    })

    await service.hardHalt({ reason: 'reference-read-failed' })

    expect(attempted).toEqual([groupId])
  })

  test('cancels an explicitly owned fully consumed group during a hard halt', async () => {
    const attempted: Hex[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listOwnedGroupIds: async () => [groupId],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async id => {
        attempted.push(id)
      }
    })

    await service.hardHalt({ reason: 'reference-read-failed' })

    expect(attempted).toEqual([groupId])
  })

  test('serializes graceful cleanup behind an in-flight publication', async () => {
    const events: string[] = []
    let releasePublication!: () => void
    let markPublicationStarted!: () => void
    const publicationGate = new Promise<void>(resolve => {
      releasePublication = resolve
    })
    const publicationStarted = new Promise<void>(resolve => {
      markPublicationStarted = resolve
    })
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listOwnedGroupIds: async () => [groupId],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: publishedGroupId,
        publish: async () => {
          events.push('publish:start')
          markPublicationStarted()
          await publicationGate
          events.push('publish:end')
        }
      }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async id => {
        events.push(`cleanup:${id}`)
      }
    })

    const publication = service.reconcile({ marketId, desiredOffer, reason: 'publish' })
    await publicationStarted
    const cleanup = service.cleanup()
    await Promise.resolve()

    expect(events).toEqual(['publish:start'])
    releasePublication()
    await Promise.all([publication, cleanup])

    expect(events).toEqual(['publish:start', 'publish:end', `cleanup:${groupId}`])
  })

  test('attempts every hard-halt cancellation and reports failures deterministically', async () => {
    const lastGroupId: Hex = `0x${'44'.repeat(32)}`
    const attempted: Hex[] = []
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [
        { id: groupId, marketId, assets: 100n, rateBps: 500n },
        { id: publishedGroupId, marketId, assets: 100n, rateBps: 500n },
        { id: lastGroupId, marketId, assets: 100n, rateBps: 500n }
      ],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({ groupId, publish: async () => {} }),
      reserveGroup: async () => {},
      confirmPublishedGroup: async () => {},
      releaseGroupReservation: async () => {},
      invalidate: async id => {
        attempted.push(id)
        if (id !== publishedGroupId) throw new BootstrapAdapterError('transaction-reverted')
      }
    })

    const error = await service.hardHalt({ reason: 'reference-read-failed' }).catch(value => value)

    expect(attempted).toEqual([groupId, publishedGroupId, lastGroupId])
    expect(error).toBeInstanceOf(BootstrapHardHaltError)
    expect(error).toMatchObject({
      failures: [
        { groupId, errorName: 'BootstrapAdapterError' },
        { groupId: lastGroupId, errorName: 'BootstrapAdapterError' }
      ]
    })
  })
})
