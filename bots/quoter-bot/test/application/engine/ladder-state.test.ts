import type { Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { WorldReading } from '../../../src/application/engine/world'

import { exposureSnapshot } from '../../../src/application/engine/exposure'
import { ladderReading } from '../../../src/application/engine/ladder-state'
import { derive } from '../../../src/application/engine/world'
import { validateLadderConfig } from '../../../src/domain/ladder'
import { MAX_LOSS_FACTOR } from '../../../src/domain/loss-factor'
import { LadderAdapterError } from '../../../src/errors'
import { accounting, maker, marketId, world } from './world.fixtures'

const groupId: Hex = `0x${'77'.repeat(32)}`
const config = validateLadderConfig({
  marketId,
  quotePremiumBps: 0n,
  spreadBps: 200n,
  stepBps: 100n,
  rungCount: 1,
  sizeSkewBps: 0n,
  lowerRateBudgetAssets: 10n,
  higherRateBudgetAssets: 10n,
  targetMarketExposureAssets: 1_000n,
  maximumTotalExposureAssets: 1_000n,
  minimumOfferAssets: 1n,
  groupMode: 'shared-rung',
  loopIntervalSeconds: 60,
  bookCrossedCooldownSeconds: 180,
  movementToleranceBps: 10n,
  minimumRateBps: 100n,
  maximumRateBps: 1_000n
})

const read = (input: WorldReading, accepted?: ReadonlyMap<Hex, bigint>) => {
  const scoped = { ...accounting, ...(accepted ? { acceptedLossFactor: accepted } : {}) }
  return ladderReading({
    world: input,
    exposure: derive(() => exposureSnapshot(input, scoped, LadderAdapterError)),
    config,
    accounting: scoped
  })
}

const withLossFactor = (lossFactor: bigint): WorldReading => {
  const base = world({ book: { ok: true, value: [] } })
  const position = base.positions[marketId]!
  return {
    ...base,
    positions: {
      ...base.positions,
      [marketId]: position.ok ? { ok: true, value: { ...position.value, lossFactor } } : position
    }
  }
}

describe('ladderReading', () => {
  test('pairs the world block loss factor with the accepted value', () => {
    expect(read(withLossFactor(7n), new Map([[marketId, 7n]])).guard).toEqual({
      ok: true,
      value: { lossFactor: 7n, acceptedLossFactor: 7n, defaulted: false }
    })
  })

  test('reads nothing else once the guard halts lending', () => {
    const reading = read(withLossFactor(7n))

    expect(reading.guard).toEqual({
      ok: true,
      value: { lossFactor: 7n, acceptedLossFactor: 0n, defaulted: true }
    })
    expect(reading).not.toHaveProperty('active')
    expect(reading).not.toHaveProperty('market')
  })

  test('fails the guard closed on a loss factor above uint128', () => {
    expect(read(withLossFactor(MAX_LOSS_FACTOR + 1n)).guard).toEqual({
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'loss-factor-read'
    })
  })

  test('fails the market read with the guard when its position read failed', () => {
    const base = world({ book: { ok: true, value: [] } })
    const reading = read({
      ...base,
      positions: { ...base.positions, [marketId]: { ok: false, errorName: 'HttpRequestError' } }
    })

    expect(reading.guard).toEqual({ ok: false, errorName: 'HttpRequestError' })
    expect(reading.market).toEqual({ ok: false, errorName: 'HttpRequestError' })
  })

  test('fails the market, not the active ladder, when only the book failed', () => {
    const reading = read(world({ book: { ok: false, errorName: 'TypeError' } }))

    expect(reading.active).toEqual({ ok: true, value: { consumption: [] } })
    expect(reading.market).toEqual({ ok: false, errorName: 'TypeError' })
  })

  test('fails both the active ladder and the market when the offer groups failed', () => {
    const failure = {
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'offer-groups-timeout'
    } as const
    const reading = read({ ...world({ book: { ok: true, value: [] } }), groups: failure })

    expect(reading.active).toEqual(failure)
    expect(reading.market).toEqual(failure)
  })

  test('derives capacities over every accounting market at the world block', () => {
    const reading = read(world({ book: { ok: true, value: [] } }))

    expect(reading.market).toMatchObject({
      ok: true,
      value: {
        creditAssets: 420n,
        otherMarketCreditAssets: 30n,
        observedTimestamp: 1_000_000n,
        maturityTimestamp: 2_000_000n
      }
    })
  })
})

describe('the own-bootstrap buy rate a ladder market must clear', () => {
  const now = 1_000_000n
  const maturity = now + 31_536_000n
  const secondGroupId: Hex = `0x${'78'.repeat(32)}`
  const bootstrapGroup = (id: Hex, tick: bigint, consumed = 0n) => ({
    id,
    consumed,
    cap: { kind: 'units' as const, maximum: 100n },
    marketId,
    tick,
    maturity,
    continuousFeeCap: 0n,
    offers: [{ marketId, maker, buy: true, tick, maturity, continuousFeeCap: 0n }]
  })
  const rateOf = (tick: bigint) => TickLib.tickToApr(tick, maturity - now) / (10n ** 18n / 10_000n)
  const bindingRate = (
    groups: ReturnType<typeof bootstrapGroup>[],
    chainConsumed: Record<string, bigint> = {}
  ) => {
    const reading = read(
      world({
        groups,
        ownership: { bootstrapGroupIds: groups.map(group => group.id) },
        consumed: chainConsumed,
        book: { ok: true, value: [] }
      })
    )
    if (!reading.market?.ok) throw new TypeError('market reading failed')
    return reading.market.value.bootstrapBuyRateBps
  }

  test('derives the rate of a live configured bootstrap group without persisted intent', () => {
    expect(bindingRate([bootstrapGroup(groupId, 500n)])).toBe(rateOf(500n))
  })

  test('selects the lowest rate when several own bootstrap buys are live', () => {
    expect(rateOf(600n)).toBeLessThan(rateOf(500n))
    expect(bindingRate([bootstrapGroup(groupId, 500n), bootstrapGroup(secondGroupId, 600n)])).toBe(
      rateOf(600n)
    )
  })

  test('reads liveness from chain consumption at the block, not from the index', () => {
    const indexedLiveSpentOnChain = bindingRate(
      [bootstrapGroup(groupId, 500n), bootstrapGroup(secondGroupId, 600n)],
      { [secondGroupId]: 100n }
    )
    const indexedSpentLiveOnChain = bindingRate(
      [bootstrapGroup(groupId, 500n), bootstrapGroup(secondGroupId, 600n, 100n)],
      { [secondGroupId]: 0n }
    )

    expect(indexedLiveSpentOnChain).toBe(rateOf(500n))
    expect(indexedSpentLiveOnChain).toBe(rateOf(600n))
  })
})

describe('the resting ladder a market reconstructs', () => {
  test('reads its groups consumption from the chain at the block, not from the index', () => {
    const sell = {
      id: groupId,
      consumed: 400n,
      cap: { kind: 'units' as const, maximum: 400n },
      offers: [{ marketId, maker, buy: false, tick: 4_520n }]
    }
    const reading = read(
      world({
        groups: [sell],
        ownership: {
          ladderPublications: [
            {
              marketId,
              status: 'confirmed',
              quote: {
                marketId,
                centerRateBps: 500n,
                referenceObservationId: 'hour:1',
                groupMode: 'shared-rung',
                lower: [{ index: 0, rateBps: 400n, assets: 400n }],
                higher: []
              },
              groups: [{ groupId, side: 'lower', rungIndexes: [0], ticks: [4_520n] }]
            }
          ]
        },
        consumed: { [groupId]: 100n },
        book: { ok: true, value: [] }
      })
    )

    expect(reading.active).toMatchObject({
      ok: true,
      value: {
        quote: { lower: [{ index: 0, assets: 300n }] },
        consumption: [{ groupId, consumed: 100n, remainingUnits: 300n }]
      }
    })
  })
})
