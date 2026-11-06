import type { Address, Hex } from 'viem'

import { MAX_TICK } from '@morpho-org/midnight-sdk'

import type { WorldOwnership, WorldReading } from '../../../src/application/engine/world'
import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

export const maker: Address = '0x1111111111111111111111111111111111111111'
export const marketId: Hex = `0x${'11'.repeat(32)}`
export const otherMarketId: Hex = `0x${'12'.repeat(32)}`
export const accounting = {
  maker,
  marketIds: [marketId, otherMarketId],
  v0OfferGroupIds: []
} as const

export const buyGroup = (
  id: Hex,
  parameters: {
    maxAssets?: bigint
    maxUnits?: bigint
    consumed?: bigint
    marketIds?: readonly Hex[]
    tick?: bigint
  }
): MakerOfferGroup => ({
  id,
  cap:
    parameters.maxUnits === undefined
      ? { kind: 'assets', maximum: parameters.maxAssets ?? 0n }
      : { kind: 'units', maximum: parameters.maxUnits },
  consumed: parameters.consumed ?? 0n,
  offers: (parameters.marketIds ?? [marketId]).map(offerMarketId => ({
    marketId: offerMarketId,
    maker,
    buy: true,
    tick: parameters.tick ?? MAX_TICK
  }))
})

/** A bootstrap offer intent, which reserves `assets` units of its market. */
export const intent = (groupId: Hex, assets: bigint, market: Hex = marketId) => ({
  groupId,
  marketId: market,
  assets,
  rateBps: 500n,
  referenceObservationId: 'hour:1'
})

const position = (market: Hex, credit: bigint) => ({
  ok: true as const,
  value: {
    marketId: market,
    credit,
    debt: 0n,
    lossFactor: 0n,
    maturity: 2_000_000n,
    tickSpacing: 4,
    continuousFee: 0
  }
})

/** One healthy poll at block 42, with `parameters` replacing any part of it. */
export const world = (
  parameters: {
    groups?: readonly MakerOfferGroup[]
    ownership?: Partial<WorldOwnership>
    consumed?: Readonly<Record<string, bigint>>
  } & Partial<Omit<WorldReading, 'groups' | 'ownership' | 'consumed'>> = {}
): WorldReading => {
  const { groups = [], ownership = {}, consumed = {}, ...rest } = parameters
  const ownershipValue: WorldOwnership = {
    ladderPublications: [],
    bootstrapGroupIds: [],
    bootstrapOffers: [],
    heldBuyGroups: [],
    retiredGroupIds: [],
    ...ownership
  }
  const known = [
    ...groups.map(group => group.id),
    ...ownershipValue.bootstrapGroupIds,
    ...ownershipValue.bootstrapOffers.map(offer => offer.groupId),
    ...ownershipValue.ladderPublications.flatMap(publication =>
      publication.groups.map(group => group.groupId)
    )
  ]
  return {
    strategy: 'ladder',
    marketId,
    block: 42,
    timestamp: 1_000_000n,
    ownership: ownershipValue,
    view: { live: [] },
    groups: { ok: true, value: groups },
    positions: {
      [marketId]: position(marketId, 420n),
      [otherMarketId]: position(otherMarketId, 30n)
    },
    cash: { ok: true, value: { cashBalance: 500n, allowance: 400n } },
    consumed: {
      ok: true,
      value: Object.fromEntries(known.map(groupId => [groupId, consumed[groupId] ?? 0n]))
    },
    ...rest
  }
}
