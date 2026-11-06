import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

import { prepareBootstrap } from '../../../src/application/engine/bootstrap-preparation'
import {
  groupId,
  indexedGroup,
  maker,
  marketId,
  maturity,
  otherMarketId,
  ratifier,
  reading,
  row,
  thirdParty
} from './preparation.fixtures'

const bootGroup = groupId('b1')
const pendingGroup = groupId('d1')
const intentless = groupId('e1')
const ladderLow = groupId('a1')
const ladderHigh = groupId('a2')
const asker = groupId('f2')

const desiredOffer = { marketId, assets: 100n, rateBps: 800n, referenceObservationId: 'hour:3' }

/** The tick 800 BPS encodes at the fixture block, tick spacing 4. */
const TICK = 4_380n

const prepare = (
  value: ReturnType<typeof reading>,
  offer = desiredOffer,
  config = { minimumRateBps: 700n, maximumRateBps: 2_000n },
  v0OfferGroupIds: readonly Hex[] = []
) =>
  prepareBootstrap({
    reading: value,
    request: { marketId, block: 100, desiredOffer: offer },
    config,
    maker,
    ratifier,
    v0OfferGroupIds
  })

/** What a publication would carry: the offer, its exact tick and cap, and the kept reserve. */
const published = (prepared: ReturnType<typeof prepareBootstrap>) =>
  'created' in prepared
    ? {
        offer: prepared.offer,
        tick: prepared.created.tick,
        maxUnits: prepared.created.maxUnits,
        start: prepared.created.start,
        reservedLoanAssets: prepared.reservedLoanAssets
      }
    : prepared

const owned = (assets: bigint, consumed = 0n) => ({
  groups: indexedGroup(bootGroup, { buy: true, tick: TICK, maxUnits: assets, consumed }),
  ownership: { bootstrapGroupIds: [bootGroup] }
})

describe('prepareBootstrap', () => {
  test('publishes the desired offer at the read block against an empty book', () => {
    expect(published(prepare(reading()))).toEqual({
      offer: desiredOffer,
      tick: TICK,
      maxUnits: 100n,
      start: 1_700_000_000n,
      reservedLoanAssets: 0n
    })
  })

  test('keeps a live owned group whose remaining assets, tick, and fee cap already match', () => {
    expect(prepare(reading(owned(100n)))).toEqual({
      offer: desiredOffer,
      retainedGroupId: bootGroup
    })
  })

  test('refuses to publish beside a configured V0 group the kernel cannot cancel', () => {
    const v0 = owned(101n, 1n)
    expect(() =>
      prepare(reading(v0), { ...desiredOffer, assets: 99n }, undefined, [bootGroup])
    ).toThrow(expect.objectContaining({ operation: 'unowned-group' }))
  })

  test('refuses to withhold a publication while a configured V0 group stays takeable', () => {
    const blocked = reading({
      ...owned(101n, 1n),
      book: [row(false, 4_100n, asker, thirdParty, 500n)]
    })
    expect(() => prepare(blocked, desiredOffer, undefined, [bootGroup])).toThrow(
      expect.objectContaining({ operation: 'unowned-group' })
    )
  })

  test('keeps a configured V0 group that already matches the desired offer', () => {
    expect(prepare(reading(owned(100n)), desiredOffer, undefined, [bootGroup])).toEqual({
      offer: desiredOffer,
      retainedGroupId: bootGroup
    })
  })

  test('replaces a live owned group one unit away from the desired offer', () => {
    expect(published(prepare(reading(owned(101n, 1n)), { ...desiredOffer, assets: 99n }))).toEqual({
      offer: { ...desiredOffer, assets: 99n },
      tick: TICK,
      maxUnits: 99n,
      start: 1_700_000_000n,
      reservedLoanAssets: 0n
    })
  })

  test('takes remaining assets from chain consumption, not the indexer', () => {
    const lagging = reading({ ...owned(100n), consumed: { [bootGroup]: 10n } })

    expect(prepare(lagging)).not.toHaveProperty('retainedGroupId')
    expect(prepare(lagging, { ...desiredOffer, assets: 90n })).toEqual({
      offer: { ...desiredOffer, assets: 90n },
      retainedGroupId: bootGroup
    })
  })

  test('keeps a pending intent the API has not indexed at its remaining assets', () => {
    expect(
      prepare(
        reading({
          ownership: {
            bootstrapGroupIds: [pendingGroup],
            bootstrapOffers: [
              {
                groupId: pendingGroup,
                marketId,
                assets: 103n,
                rateBps: 800n,
                referenceObservationId: 'hour:2',
                tick: TICK,
                continuousFeeCap: 0n
              }
            ]
          },
          consumed: { [pendingGroup]: 3n }
        })
      )
    ).toEqual({ offer: desiredOffer, retainedGroupId: pendingGroup })
  })

  test('reprices clear of a third-party ask at or below its tick', () => {
    expect(
      published(prepare(reading({ book: [row(false, TICK - 8n, asker, thirdParty, 500n)] })))
    ).toMatchObject({ offer: { ...desiredOffer, rateBps: 846n }, tick: TICK - 12n })
  })

  test('reprices clear of its own ladder sell the API has not indexed', () => {
    const sell: OwnedLadderPublication = {
      marketId,
      status: 'reserved',
      quote: {
        marketId,
        centerRateBps: 500n,
        groupMode: 'shared-rung',
        lower: [{ index: 0, rateBps: 400n, assets: 400n }],
        higher: []
      },
      groups: [{ groupId: ladderLow, side: 'lower', rungIndexes: [0], ticks: [TICK - 8n] }]
    }

    expect(
      published(prepare(reading({ ownership: { ladderPublications: [sell] } })))
    ).toMatchObject({ offer: { ...desiredOffer, rateBps: 846n }, tick: TICK - 12n })
  })

  test('publishes nothing when no clearing tick is inside the rate range', () => {
    expect(prepare(reading({ book: [row(false, 4_100n, asker, thirdParty, 500n)] }))).toEqual({})
  })

  test('keeps every other live buy group reserved beside the publication', () => {
    const ladderBuy = indexedGroup(ladderHigh, { buy: true, tick: 4_440n, maxUnits: 400n })

    expect(published(prepare(reading({ groups: ladderBuy })))).toMatchObject({
      reservedLoanAssets: 399n
    })
    expect(
      published(
        prepare(
          reading({ groups: [...ladderBuy, ...owned(50n).groups], ownership: owned(50n).ownership })
        )
      )
    ).toMatchObject({ reservedLoanAssets: 399n })
  })

  test('reserves other buys by chain consumption, unindexed intents included', () => {
    const ladderBuy = indexedGroup(ladderHigh, { buy: true, tick: 4_440n, maxUnits: 400n })
    const otherMarketIntent = {
      groupId: pendingGroup,
      marketId: otherMarketId,
      assets: 100n,
      rateBps: 800n,
      referenceObservationId: 'hour:2',
      tick: TICK,
      continuousFeeCap: 0n
    }

    expect(
      published(
        prepare(
          reading({
            groups: ladderBuy,
            consumed: { [ladderHigh]: 200n },
            ownership: { bootstrapGroupIds: [pendingGroup], bootstrapOffers: [otherMarketIntent] }
          })
        )
      )
    ).toMatchObject({ reservedLoanAssets: 200n + 100n })
  })

  test('refuses a range that holds no tick at the read block', () => {
    expect(() =>
      prepare(reading({ timestamp: maturity - 60n }), desiredOffer, {
        minimumRateBps: 800n,
        maximumRateBps: 801n
      })
    ).toThrow(expect.objectContaining({ operation: 'rate-window-empty' }))
  })

  test('refuses a matured market', () => {
    expect(() => prepare(reading({ timestamp: maturity + 10n }))).toThrow()
  })

  test('fails closed on an owned group shared with another market', () => {
    expect(() =>
      prepare(
        reading({
          groups: indexedGroup(bootGroup, {
            buy: true,
            tick: TICK,
            maxUnits: 100n,
            marketIds: [marketId, otherMarketId]
          }),
          ownership: { bootstrapGroupIds: [bootGroup] }
        })
      )
    ).toThrow(expect.objectContaining({ operation: 'shared-group-reconciliation' }))
  })

  test('fails closed on an owned group no intent explains', () => {
    expect(() => prepare(reading({ ownership: { bootstrapGroupIds: [intentless] } }))).toThrow(
      expect.objectContaining({
        name: 'BootstrapAdapterError',
        operation: 'missing-owned-group-intent'
      })
    )
  })

  test('fails closed on a live cash-capped buy group, as the world exposure does', () => {
    const cashCapped = indexedGroup(groupId('c2'), { buy: true, tick: 4_250n, maxUnits: 70n }).map(
      group => ({ ...group, cap: { kind: 'assets' as const, maximum: 70n } })
    )

    expect(() => prepare(reading({ groups: cashCapped }))).toThrow(
      expect.objectContaining({ operation: 'cash-capped-buy-group' })
    )
  })
})
