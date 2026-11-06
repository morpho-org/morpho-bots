import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import type { PreparationReading, WorldOwnership } from '../../../src/application/engine/world'
import type { OwnedOverlapBookOffer } from '../../../src/domain/intentional-overlap'
import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

export const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
export const thirdParty: Address = '0x00000000000000000000000000000000000000AA'
export const ratifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'
export const marketId: Hex = `0x${'55'.repeat(32)}`
export const otherMarketId: Hex = `0x${'66'.repeat(32)}`
export const groupId = (byte: string): Hex => `0x${byte.repeat(32)}`
export const NOW = 1_700_000_000n
export const maturity = NOW + 30n * 86_400n

export const market = (tickSpacing = 4): IMarket =>
  ({
    params: {
      chainId: 8453,
      midnight: '0x2222222222222222222222222222222222222222',
      loanToken: '0x3333333333333333333333333333333333333333',
      collateralParams: [
        {
          token: '0x5555555555555555555555555555555555555555',
          lltv: 800_000_000_000_000_000n,
          liquidationCursor: 0n,
          oracle: '0x6666666666666666666666666666666666666666'
        }
      ],
      maturity,
      rcfThreshold: 0n,
      enterGate: '0x0000000000000000000000000000000000000000',
      liquidatorGate: '0x0000000000000000000000000000000000000000'
    },
    tickSpacing,
    continuousFee: 0
  }) as unknown as IMarket

/** One indexed, units-capped maker group with one offer per tick, as the offer-groups API parses. */
export const indexedGroup = (
  id: Hex,
  parameters: {
    buy: boolean
    tick: bigint
    maxUnits: bigint
    consumed?: bigint
    marketIds?: readonly Hex[]
  }
): MakerOfferGroup[] => {
  const offers = (parameters.marketIds ?? [marketId]).map(offerMarketId => ({
    marketId: offerMarketId,
    maker,
    buy: parameters.buy,
    tick: parameters.tick,
    maturity,
    continuousFeeCap: 0n
  }))
  const common = {
    id,
    consumed: parameters.consumed ?? 0n,
    cap: { kind: 'units' as const, maximum: parameters.maxUnits },
    offers
  }
  return parameters.buy
    ? offers.map(offer => ({
        ...common,
        marketId: offer.marketId,
        tick: offer.tick,
        maturity,
        continuousFeeCap: 0n
      }))
    : [common]
}

/** One takeable-book row. */
export const row = (
  buy: boolean,
  tick: bigint,
  group: Hex,
  owner: Address,
  units: bigint
): OwnedOverlapBookOffer => ({ groupId: group, marketId, maker: owner, units, buy, tick })

/** One preparation read at block 100, every known group's consumption zero unless given. */
export const reading = (
  parameters: {
    timestamp?: bigint
    tickSpacing?: number
    groups?: readonly MakerOfferGroup[]
    book?: readonly OwnedOverlapBookOffer[]
    consumed?: Readonly<Record<string, bigint>>
    ownership?: Partial<WorldOwnership>
  } = {}
): PreparationReading => {
  const ownership: WorldOwnership = {
    ladderPublications: [],
    bootstrapGroupIds: [],
    bootstrapOffers: [],
    heldBuyGroups: [],
    retiredGroupIds: [],
    ...parameters.ownership
  }
  const groups = parameters.groups ?? []
  const known = [
    ...groups.map(group => group.id),
    ...ownership.bootstrapGroupIds,
    ...ownership.bootstrapOffers.map(offer => offer.groupId),
    ...ownership.ladderPublications.flatMap(publication =>
      publication.groups.map(group => group.groupId)
    )
  ]
  return {
    block: { number: 100n, timestamp: parameters.timestamp ?? NOW },
    ownership,
    groups,
    book: parameters.book ?? [],
    market: market(parameters.tickSpacing),
    consumed: Object.fromEntries(
      known.map(id => [
        id,
        parameters.consumed?.[id] ?? groups.find(g => g.id === id)?.consumed ?? 0n
      ])
    )
  }
}
