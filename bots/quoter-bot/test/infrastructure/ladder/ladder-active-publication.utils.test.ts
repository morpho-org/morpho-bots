import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder'
import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'
import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

import { sameLadderQuoteSet } from '../../../src/application/ladder/ladder-quoter.utils'
import { offerCapsByRung } from '../../../src/domain/ladder'
import {
  activeOwnedLadderGroupIds,
  activeOwnedLadderGroupIdsBySide,
  ownedLadderGroupConsumption,
  ownedLadderBookOffers,
  reconstructOwnedLadderPublication
} from '../../../src/infrastructure/ladder/ladder-active-publication.utils'
import { createLadderGroupOwnership } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'
import { buildLadderTree } from '../../../src/infrastructure/ladder/ladder-offer.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const lowerGroupId: Hex = `0x${'22'.repeat(32)}`
const higherGroupId: Hex = `0x${'33'.repeat(32)}`
const maker = '0x4444444444444444444444444444444444444444' as const

const publication: OwnedLadderPublication = {
  marketId,
  status: 'confirmed',
  quote: {
    marketId,
    centerRateBps: 500n,
    groupMode: 'per-book',
    lower: [{ index: 0, rateBps: 450n, assets: 100n }],
    higher: [{ index: 0, rateBps: 550n, assets: 80n }]
  },
  groups: [
    { groupId: lowerGroupId, side: 'lower', rungIndexes: [0], ticks: [120n] },
    { groupId: higherGroupId, side: 'higher', rungIndexes: [0], ticks: [110n] }
  ]
}

const indexedGroup = (id: Hex, consumed: bigint, maximum: bigint): MakerOfferGroup => ({
  id,
  consumed,
  cap: { kind: 'units', maximum },
  offers: [{ marketId, maker, buy: true, tick: 1n }]
})

describe('ladder active publication indexing', () => {
  test('reconstructs an unconsumed publication to exactly its persisted quote', () => {
    const caps = offerCapsByRung(publication.quote)
    const groups = [
      indexedGroup(lowerGroupId, 0n, caps.lower[0]!),
      indexedGroup(higherGroupId, 0n, caps.higher[0]!)
    ]
    const reconstructed = reconstructOwnedLadderPublication(publication, groups)

    expect(reconstructed).toEqual(publication.quote)
    expect(sameLadderQuoteSet(reconstructed!, publication.quote)).toBe(true)
  })

  test('keeps a used-up buy active until it is cancelled, since it can still be taken', () => {
    const groups = [indexedGroup(higherGroupId, 80n, 80n)]

    expect(activeOwnedLadderGroupIds([publication], groups, marketId)).toEqual([
      lowerGroupId,
      higherGroupId
    ])
    expect(
      activeOwnedLadderGroupIds(
        [publication],
        [indexedGroup(higherGroupId, MAX_OFFER_CAP, 80n)],
        marketId
      )
    ).toEqual([lowerGroupId])
  })

  test('retains API-missing confirmed groups as pending active rungs', () => {
    expect(reconstructOwnedLadderPublication(publication, [])).toEqual(publication.quote)
    expect(activeOwnedLadderGroupIds([publication], [], marketId)).toEqual([
      lowerGroupId,
      higherGroupId
    ])
  })

  test('uses indexed remaining capacity and drops only indexed closed groups', () => {
    const groups = [
      indexedGroup(lowerGroupId, 40n, 100n),
      indexedGroup(higherGroupId, MAX_OFFER_CAP, 80n)
    ]

    expect(reconstructOwnedLadderPublication(publication, groups)).toEqual({
      ...publication.quote,
      lower: [{ index: 0, rateBps: 450n, assets: 60n }],
      higher: []
    })
    expect(activeOwnedLadderGroupIds([publication], groups, marketId)).toEqual([lowerGroupId])
    expect(ownedLadderBookOffers([publication], groups, marketId)).toEqual([
      { groupId: lowerGroupId, marketId, buy: false, tick: 120n }
    ])
  })

  test('replays active groups at their persisted ticks, even when indexed without offers', () => {
    const groups = [{ ...indexedGroup(higherGroupId, 0n, 80n), offers: [] }]

    expect(ownedLadderBookOffers([publication], groups, marketId)).toEqual([
      { groupId: lowerGroupId, marketId, buy: false, tick: 120n },
      { groupId: higherGroupId, marketId, buy: true, tick: 110n }
    ])
    expect(ownedLadderBookOffers([publication], [], `0x${'99'.repeat(32)}`)).toEqual([])
  })

  test('replays every offer tick a per-book group was signed with', () => {
    const perBook: OwnedLadderPublication = {
      ...publication,
      groups: [{ groupId: higherGroupId, side: 'higher', rungIndexes: [0, 1], ticks: [90n, 80n] }]
    }

    expect(ownedLadderBookOffers([perBook], [], marketId)).toEqual([
      { groupId: higherGroupId, marketId, buy: true, tick: 90n },
      { groupId: higherGroupId, marketId, buy: true, tick: 80n }
    ])
  })
})

describe('ownedLadderGroupConsumption', () => {
  const otherMarketId: Hex = `0x${'55'.repeat(32)}`
  const otherGroupId: Hex = `0x${'66'.repeat(32)}`

  const lowerPublication: OwnedLadderPublication = {
    marketId,
    status: 'confirmed',
    quote: {
      marketId,
      centerRateBps: 500n,
      groupMode: 'per-book',
      lower: [
        { index: 0, rateBps: 450n, assets: 60n },
        { index: 1, rateBps: 350n, assets: 40n }
      ],
      higher: []
    },
    groups: [{ groupId: lowerGroupId, side: 'lower', rungIndexes: [1, 0], ticks: [100n] }]
  }

  const higherPublication: OwnedLadderPublication = {
    marketId,
    status: 'confirmed',
    quote: {
      marketId,
      centerRateBps: 500n,
      groupMode: 'per-book',
      lower: [],
      higher: [{ index: 0, rateBps: 550n, assets: 80n }]
    },
    groups: [{ groupId: higherGroupId, side: 'higher', rungIndexes: [0], ticks: [100n] }]
  }

  test('resolves each side rate independently when both sides reuse the same rung indexes', () => {
    expect(
      ownedLadderGroupConsumption(
        [publication],
        [indexedGroup(lowerGroupId, 10n, 100n), indexedGroup(higherGroupId, 20n, 80n)]
      )
    ).toMatchObject([
      { groupId: lowerGroupId, side: 'lower', groupRateBps: 450n },
      { groupId: higherGroupId, side: 'higher', groupRateBps: 550n }
    ])
  })

  test('joins each indexed group to its side, nearest rate, and remaining capacity', () => {
    expect(
      ownedLadderGroupConsumption(
        [lowerPublication, higherPublication],
        [indexedGroup(lowerGroupId, 40n, 100n), indexedGroup(higherGroupId, 90n, 80n)]
      )
    ).toEqual([
      {
        groupId: lowerGroupId,
        marketId,
        side: 'lower',
        groupRateBps: 450n,
        maxUnits: 100n,
        consumed: 40n,
        remainingUnits: 60n
      },
      {
        groupId: higherGroupId,
        marketId,
        side: 'higher',
        groupRateBps: 550n,
        maxUnits: 80n,
        consumed: 90n,
        remainingUnits: 0n
      }
    ])
  })

  test('omits owned groups the indexer has not returned yet', () => {
    expect(
      ownedLadderGroupConsumption(
        [lowerPublication, higherPublication],
        [indexedGroup(higherGroupId, 0n, 80n)]
      ).map(group => group.groupId)
    ).toEqual([higherGroupId])
  })

  test('keeps the first publication that claims a repeated group id', () => {
    const republished: OwnedLadderPublication = {
      ...lowerPublication,
      status: 'reserved',
      quote: {
        ...lowerPublication.quote,
        lower: [{ index: 0, rateBps: 410n, assets: 100n }]
      },
      groups: [{ groupId: lowerGroupId, side: 'lower', rungIndexes: [0], ticks: [100n] }]
    }

    expect(
      ownedLadderGroupConsumption(
        [lowerPublication, republished],
        [indexedGroup(lowerGroupId, 0n, 100n)]
      )
    ).toMatchObject([{ groupId: lowerGroupId, groupRateBps: 450n }])
  })

  test('restricts consumption to the requested strategy market', () => {
    const foreign: OwnedLadderPublication = {
      marketId: otherMarketId,
      status: 'confirmed',
      quote: {
        marketId: otherMarketId,
        centerRateBps: 600n,
        groupMode: 'per-book',
        lower: [{ index: 0, rateBps: 550n, assets: 50n }],
        higher: []
      },
      groups: [{ groupId: otherGroupId, side: 'lower', rungIndexes: [0], ticks: [100n] }]
    }
    const groups = [indexedGroup(lowerGroupId, 0n, 100n), indexedGroup(otherGroupId, 0n, 50n)]

    expect(
      ownedLadderGroupConsumption([lowerPublication, foreign], groups, marketId).map(
        group => group.groupId
      )
    ).toEqual([lowerGroupId])
    expect(
      ownedLadderGroupConsumption([lowerPublication, foreign], groups, otherMarketId)
    ).toMatchObject([{ groupId: otherGroupId, marketId: otherMarketId }])
  })
})

describe('activeOwnedLadderGroupIdsBySide', () => {
  const otherMarketId: Hex = `0x${'99'.repeat(32)}`

  test('splits the active groups of one market by the side each was published on', () => {
    expect(
      activeOwnedLadderGroupIdsBySide(
        [publication],
        marketId,
        new Set([lowerGroupId, higherGroupId])
      )
    ).toEqual({ lower: new Set([lowerGroupId]), higher: new Set([higherGroupId]) })
  })

  test('omits a group the active set no longer reports', () => {
    expect(
      activeOwnedLadderGroupIdsBySide([publication], marketId, new Set([higherGroupId]))
    ).toEqual({ lower: new Set(), higher: new Set([higherGroupId]) })
  })

  test('omits every publication of another market', () => {
    expect(
      activeOwnedLadderGroupIdsBySide(
        [publication],
        otherMarketId,
        new Set([lowerGroupId, higherGroupId])
      )
    ).toEqual({ lower: new Set(), higher: new Set() })
  })
})

describe('ownedLadderBookOffers near maturity', () => {
  const publishedAt = 1_000n
  const maturity = publishedAt + 30n * 86_400n
  const market = {
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
    tickSpacing: 1,
    continuousFee: 0
  } as unknown as IMarket
  const quote: LadderQuoteSet = {
    marketId,
    centerRateBps: 500n,
    groupMode: 'shared-rung',
    lower: [{ index: 0, rateBps: 450n, assets: 10n }],
    higher: []
  }
  const build = (now: bigint) =>
    buildLadderTree({
      quote,
      market,
      maker,
      ratifier: maker,
      now,
      minimumRateBps: 1n,
      maximumRateBps: 10_000n
    })

  test('replays the published sell tick after a state round trip, not a re-encoding', async () => {
    const published = build(publishedAt)
    const [publishedSell] = published.bookOffers
    const nearMaturity = maturity - 3_600n
    expect(build(nearMaturity).bookOffers[0]!.tick).not.toBe(publishedSell!.tick)

    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-pending-ticks-'))
    try {
      const ownership = createLadderGroupOwnership({ chainId: 8453, maker }, { stateDirectory })
      await ownership.reserve({ marketId, quote, groups: published.groups })

      expect(ownedLadderBookOffers(await ownership.read(), [], marketId)).toEqual([
        {
          groupId: published.groups[0]!.groupId,
          marketId,
          buy: false,
          tick: publishedSell!.tick
        }
      ])
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
