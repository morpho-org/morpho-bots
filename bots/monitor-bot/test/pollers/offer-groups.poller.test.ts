import { describe, expect, it, vi } from 'vitest'

import type { MidnightClient } from '../../src/midnight/client'

import { InMemoryCursorStore } from '../../src/cursor/cursor.store'
import { OfferGroupsPoller } from '../../src/pollers/offer-groups.poller'
import { capturingDispatcher, fakeLogger } from '../helpers'
import { apiPage, USER_ONE, USER_TWO } from '../midnight/fixtures'

const GROUP_1 = `0x${'1'.repeat(64)}`
const GROUP_2 = `0x${'2'.repeat(64)}`

function offerGroup(over: {
  id: string
  max_assets?: string
  max_units?: string
  consumed?: string
  buy?: boolean
}) {
  return {
    id: over.id,
    chain_id: 8453,
    created_at: 100,
    expiry: 2000,
    max_units: over.max_units ?? '0',
    max_assets: over.max_assets ?? '1000',
    consumed: over.consumed ?? '0',
    offers: [
      {
        market_id: `0x${'e'.repeat(64)}`,
        market: {
          loan_token: USER_TWO,
          maturity: 2000,
          rcf_threshold: '0',
          enter_gate: USER_TWO,
          liquidator_gate: USER_TWO,
          collaterals: []
        },
        created_at: 100,
        buy: over.buy ?? true,
        maker: USER_ONE,
        max_units: over.max_units ?? '0',
        max_assets: over.max_assets ?? '1000',
        continuous_fee_cap: '0',
        start: 100,
        expiry: 2000,
        tick: 6600,
        callback: USER_TWO,
        callback_data: '0x',
        receiver_if_maker_is_seller: USER_TWO,
        ratifier: USER_TWO,
        reduce_only: false
      }
    ]
  }
}

type Snapshot = ReturnType<typeof offerGroup>[]

function makePoller(snapshots: Snapshot[], minAssets = 0n) {
  const queue = [...snapshots]
  const client = {
    GET: vi.fn(() => {
      const groups = queue.length > 1 ? queue.shift() : queue[0]
      return Promise.resolve(apiPage({ cursor: null, data: groups ?? [] }))
    })
  } as unknown as MidnightClient
  const dispatcher = capturingDispatcher()
  const logger = fakeLogger()
  const poller = new OfferGroupsPoller(
    { cron: '*/30 * * * * *', makers: [USER_ONE] },
    {
      cursors: new InMemoryCursorStore(),
      dispatcher,
      logger,
      client,
      minAssets,
      sleep: () => Promise.resolve()
    }
  )
  return { poller, dispatcher, logger, client }
}

describe('OfferGroupsPoller', () => {
  it('treats the first tick per maker as a quiet baseline', async () => {
    const { poller, dispatcher, logger } = makePoller([[offerGroup({ id: GROUP_1 })]])
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
    expect(logger.info).toHaveBeenCalledWith('poll.baseline', {
      pollerId: 'make-orders',
      maker: USER_ONE,
      groups: 1
    })
  })

  it('alerts on a newly created group after the baseline', async () => {
    const { poller, dispatcher } = makePoller([
      [offerGroup({ id: GROUP_1 })],
      [offerGroup({ id: GROUP_1 }), offerGroup({ id: GROUP_2, max_assets: '500' })]
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.[0]?.key).toBe(`${GROUP_2}:created`)
    expect(dispatcher.sent[0]?.[0]?.title).toBe('make order posted (lend): max 500 assets')
  })

  it('alerts on size changes but ignores consumed-only changes', async () => {
    const { poller, dispatcher } = makePoller([
      [offerGroup({ id: GROUP_1, max_assets: '1000', consumed: '0' })],
      [offerGroup({ id: GROUP_1, max_assets: '1000', consumed: '400' })],
      [offerGroup({ id: GROUP_1, max_assets: '2000', consumed: '400' })]
    ])
    await poller.pollOnce()
    // consumed moved 0 → 400: take activity, no alert.
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
    // max_assets moved 1000 → 2000: resize alert.
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.[0]?.key).toBe(`${GROUP_1}:resized:2000`)
    expect(dispatcher.sent[0]?.[0]?.title).toBe(
      'make order resized (lend): max 2000 assets (was 1000)'
    )
  })

  it('alerts when a group disappears', async () => {
    const { poller, dispatcher } = makePoller([[offerGroup({ id: GROUP_1 })], []])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.[0]?.key).toBe(`${GROUP_1}:closed`)
    expect(dispatcher.sent[0]?.[0]?.title).toBe('make order closed: max 1000 assets')
  })

  it('applies the size filter to make-order events', async () => {
    const { poller, dispatcher } = makePoller(
      [
        [offerGroup({ id: GROUP_1 })],
        [offerGroup({ id: GROUP_1 }), offerGroup({ id: GROUP_2, max_assets: '5' })]
      ],
      100n
    )
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
  })

  it('keeps the previous snapshot when a maker fetch fails, then diffs against it', async () => {
    const { poller, dispatcher, client } = makePoller([[offerGroup({ id: GROUP_1 })]])
    await poller.pollOnce()

    const mock = client.GET as ReturnType<typeof vi.fn>
    mock
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
    // Single maker: the all-makers-failed guard trips and the tick throws (cursor untouched).
    await expect(poller.pollOnce()).rejects.toThrow('all 1 makers failed')

    // Next tick succeeds with the group gone — diffed against the baseline snapshot.
    mock.mockImplementation(() => Promise.resolve(apiPage({ cursor: null, data: [] })))
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.[0]?.key).toBe(`${GROUP_1}:closed`)
  })
})
