import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { WorldReading } from '../../../src/application/engine/world'
import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

import { bootstrapReading } from '../../../src/application/engine/bootstrap-state'
import { exposureSnapshot } from '../../../src/application/engine/exposure'
import { derive } from '../../../src/application/engine/world'
import {
  bootstrapSizeCapacity,
  validateBootstrapConfig
} from '../../../src/domain/position-bootstrap'
import { BootstrapAdapterError } from '../../../src/errors'
import {
  accounting,
  buyGroup,
  intent,
  maker,
  marketId,
  otherMarketId,
  world
} from './world.fixtures'

const firstGroup: Hex = `0x${'22'.repeat(32)}`
const secondGroup: Hex = `0x${'33'.repeat(32)}`
const config = validateBootstrapConfig({
  marketId,
  creditTarget: 1_000n,
  acceptanceAssets: 0n,
  offerSize: 1_000n,
  premiumBps: 0n,
  maximumMarketExposure: 1_000n,
  maximumTotalExposure: 1_000n,
  minimumRateBps: 200n,
  maximumRateBps: 800n,
  autoRefill: false
})

/** An indexed bootstrap group: one buy per offer in `market`, at its fee cap. */
const bootstrapGroup = (
  id: Hex,
  parameters: {
    maxUnits: bigint
    market?: Hex
    offers?: number
    continuousFeeCap?: bigint
  }
): MakerOfferGroup => {
  const market = parameters.market ?? marketId
  const offer = {
    marketId: market,
    maker,
    buy: true,
    tick: 4_400n,
    maturity: 2_000_000n,
    continuousFeeCap: parameters.continuousFeeCap ?? 0n
  }
  return {
    id,
    cap: { kind: 'units', maximum: parameters.maxUnits },
    consumed: 0n,
    marketId: market,
    tick: offer.tick,
    maturity: offer.maturity,
    continuousFeeCap: offer.continuousFeeCap,
    offers: Array.from({ length: parameters.offers ?? 1 }, () => offer)
  }
}

const read = (input: WorldReading, market: Hex = marketId) => {
  const world = { ...input, strategy: 'bootstrap' as const, marketId: market }
  const reading = bootstrapReading({
    world,
    exposure: derive(() => exposureSnapshot(world, accounting, BootstrapAdapterError)),
    config: { ...config, marketId: market },
    accounting,
    initialTargetCompleted: false
  })
  if (!reading.position.ok) throw new Error(`position failed: ${reading.position.errorName}`)
  return reading.position.value
}

describe('bootstrapReading', () => {
  test('reads the position, maturity, rate window, and loss factor at the world block', () => {
    expect(read(world())).toEqual({
      maturityTimestamp: 2_000_000n,
      observedTimestamp: 1_000_000n,
      rateWindowEmpty: false,
      credit: 420n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: 400n,
      marketExposure: 420n,
      totalExposure: 450n,
      requiresReconciliation: false
    })
  })

  test('excludes the market live group from the capacity available to replace itself', () => {
    const position = read(
      world({
        groups: [bootstrapGroup(firstGroup, { maxUnits: 100n })],
        ownership: { bootstrapGroupIds: [firstGroup] },
        consumed: { [firstGroup]: 40n }
      })
    )

    expect(position).toMatchObject({
      cashBalance: 400n,
      marketExposure: 420n,
      totalExposure: 450n,
      activeOffer: {
        marketId,
        assets: 60n,
        referenceObservationId: `group:${firstGroup}`
      }
    })
  })

  test('keeps every other group, owned or not, in replacement exposure and reserved cash', () => {
    const foreign: Hex = `0x${'44'.repeat(32)}`
    const position = read(
      world({
        groups: [
          bootstrapGroup(firstGroup, { maxUnits: 20n }),
          bootstrapGroup(secondGroup, { maxUnits: 30n }),
          buyGroup(foreign, { maxUnits: 70n, marketIds: [otherMarketId] })
        ],
        ownership: { bootstrapGroupIds: [firstGroup, secondGroup] }
      })
    )

    expect(position).toMatchObject({
      cashBalance: 300n,
      marketExposure: 450n,
      totalExposure: 550n,
      requiresReconciliation: true
    })
  })

  test('counts a shared multi-market group once in aggregate exposure', () => {
    const shared = buyGroup(firstGroup, { maxUnits: 100n, marketIds: [marketId, otherMarketId] })
    const position = read(world({ groups: [shared] }))

    expect(position).toMatchObject({ totalExposure: 550n, cashBalance: 300n })
  })

  test('rehydrates the persisted intended rate and reference observation', () => {
    const position = read(
      world({
        groups: [bootstrapGroup(firstGroup, { maxUnits: 100n })],
        ownership: {
          bootstrapGroupIds: [firstGroup],
          bootstrapOffers: [
            { ...intent(firstGroup, 100n), rateBps: 450n, referenceObservationId: 'blocks:1-2' }
          ]
        }
      })
    )

    expect(position.activeOffer).toEqual({
      marketId,
      assets: 100n,
      rateBps: 450n,
      referenceObservationId: 'blocks:1-2'
    })
  })

  test('reads a pending offer intent back at its remaining size, without its fee cap', () => {
    const position = read(
      world({
        ownership: { bootstrapGroupIds: [firstGroup], bootstrapOffers: [intent(firstGroup, 500n)] },
        consumed: { [firstGroup]: 100n }
      })
    )

    expect(position).toMatchObject({
      activeOffer: { marketId, assets: 400n, rateBps: 500n, referenceObservationId: 'hour:1' },
      requiresReconciliation: true
    })
  })

  test('drops a cancelled owned group', () => {
    const position = read(
      world({
        groups: [bootstrapGroup(firstGroup, { maxUnits: 100n })],
        ownership: { bootstrapGroupIds: [firstGroup] },
        consumed: { [firstGroup]: MAX_OFFER_CAP }
      })
    )

    expect(position.activeOffer).toBeUndefined()
  })

  test('forces reconciliation for duplicate groups, a multi-offer group, or a stale fee cap', () => {
    const owned = (...groups: MakerOfferGroup[]) =>
      read(world({ groups, ownership: { bootstrapGroupIds: groups.map(group => group.id) } }))
        .requiresReconciliation

    expect(owned(bootstrapGroup(firstGroup, { maxUnits: 10n }))).toBe(false)
    expect(
      owned(
        bootstrapGroup(firstGroup, { maxUnits: 10n }),
        bootstrapGroup(secondGroup, { maxUnits: 10n })
      )
    ).toBe(true)
    expect(owned(bootstrapGroup(firstGroup, { maxUnits: 10n, offers: 2 }))).toBe(true)
    expect(owned(bootstrapGroup(firstGroup, { maxUnits: 10n, continuousFeeCap: 1n }))).toBe(true)
  })

  test('sizes the next offer down to an allowance a fill has drained below cash', () => {
    const position = read(
      world({ cash: { ok: true, value: { cashBalance: 940n, allowance: 30n } } })
    )

    expect(
      bootstrapSizeCapacity(
        {
          offerSize: 1_000n,
          creditTarget: 1_000n,
          maximumMarketExposure: 1_000n,
          maximumTotalExposure: 1_000n
        },
        { ...position, credit: 60n, marketExposure: 60n, totalExposure: 60n }
      )
    ).toEqual({ assets: 30n, cap: 'cash-balance' })
  })

  test('fails as its position read failed, named as the bootstrap names it', () => {
    const failed: WorldReading = {
      ...world(),
      strategy: 'bootstrap',
      groups: {
        ok: false,
        errorName: 'LadderAdapterError',
        adapterOperation: 'offer-groups-timeout'
      }
    }
    const reading = bootstrapReading({
      world: failed,
      exposure: derive(() => exposureSnapshot(failed, accounting, BootstrapAdapterError)),
      config,
      accounting,
      initialTargetCompleted: false
    })

    expect(reading.position).toEqual({
      ok: false,
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'offer-groups-timeout'
    })
  })

  test('carries the completion the cycle history recorded before this poll', () => {
    expect(
      bootstrapReading({
        world: { ...world(), strategy: 'bootstrap' },
        exposure: { ok: false, errorName: 'UnknownError' },
        config,
        accounting,
        initialTargetCompleted: true
      }).initialTargetCompleted
    ).toBe(true)
  })
})
