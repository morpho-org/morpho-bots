import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
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
    const service = new MidnightBootstrapMakeService(
      {
        listActiveGroups: async () => [],
        listBookOffers: async () => [{ marketId, buy: false, tick: 100n }],
        toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
        publish: async () => {
          published = true
          return publishedGroupId
        },
        invalidate: async () => {}
      },
      [groupId]
    )

    const error = await service
      .reconcile({ marketId, desiredOffer, reason: 'publish' })
      .catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'negative-spread' })
    expect(published).toBe(false)
  })

  test('reloads the whole book immediately before publishing a safe offer', async () => {
    const events: string[] = []
    const service = new MidnightBootstrapMakeService(
      {
        listActiveGroups: async () => [],
        listBookOffers: async () => {
          events.push('book')
          return [{ marketId, buy: false, tick: 101n }]
        },
        toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
        publish: async () => {
          events.push('publish')
          return publishedGroupId
        },
        invalidate: async () => {}
      },
      [groupId]
    )

    await service.reconcile({ marketId, desiredOffer, reason: 'publish' })

    expect(events).toEqual(['book', 'publish'])
  })
})
