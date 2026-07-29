import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapHardHaltError } from '../../../src/infrastructure/bootstrap/bootstrap-hard-halt.error'
import { MidnightBootstrapMakeService } from '../../../src/infrastructure/bootstrap/bootstrap-make.service'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`
const publishedGroupId: Hex = `0x${'33'.repeat(32)}`
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

    expect([...owned]).toEqual([publishedGroupId])
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
