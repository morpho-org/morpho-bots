import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, MAX_TICK } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { WorldOwnership } from '../../../src/application/engine/world'

import { completeBook } from '../../../src/application/engine/complete-book'
import { LadderAdapterError } from '../../../src/errors'
import { buyGroup, intent, maker, marketId, otherMarketId } from './world.fixtures'

const thirdParty: Address = '0x00000000000000000000000000000000000000AA'
const id = (byte: string): Hex => `0x${byte.repeat(32)}`
const ladderLow = id('a1')
const bootstrapGroup = id('b1')
const pendingGroup = id('d1')
const foreign = id('f1')

const ownership = (overrides: Partial<WorldOwnership> = {}): WorldOwnership => ({
  ladderPublications: [],
  bootstrapGroupIds: [],
  bootstrapOffers: [],
  heldBuyGroups: [],
  retiredGroupIds: [],
  ...overrides
})

/** Assesses a book; consumption defaults to what the indexer reports for each group. */
const book = (parameters: Partial<Parameters<typeof completeBook>[0]>) =>
  completeBook({
    marketId,
    maker,
    v0OfferGroupIds: [],
    book: [],
    groups: [],
    ownership: ownership(),
    adapterError: LadderAdapterError,
    ...parameters,
    consumed:
      parameters.consumed ??
      Object.fromEntries((parameters.groups ?? []).map(group => [group.id, group.consumed]))
  })

describe('completeBook', () => {
  test('keeps one offer per group, side, and tick, the API row first', () => {
    const indexed = buyGroup(bootstrapGroup, { maxUnits: 100n, tick: 4_400n })
    const apiRow = {
      groupId: bootstrapGroup,
      marketId,
      maker,
      units: 100n,
      buy: true,
      tick: 4_400n
    }

    expect(book({ book: [apiRow], groups: [indexed] })).toEqual([apiRow])
  })

  test('marks every buy of a durably owned bootstrap group, the API row included', () => {
    const apiRow = { groupId: bootstrapGroup, marketId, maker, buy: true, tick: 4_400n }

    expect(
      book({
        book: [apiRow],
        ownership: ownership({ bootstrapGroupIds: [bootstrapGroup] }),
        groups: [buyGroup(bootstrapGroup, { maxUnits: 100n, tick: 4_400n })]
      })
    ).toEqual([{ ...apiRow, overlapOwner: 'bootstrap-buy' }])
  })

  test('adds a live pending bootstrap intent at its persisted tick, as the maker', () => {
    expect(
      book({
        ownership: ownership({
          bootstrapGroupIds: [pendingGroup],
          bootstrapOffers: [{ ...intent(pendingGroup, 90n), tick: 4_410n }]
        }),
        consumed: { [pendingGroup]: 3n }
      })
    ).toEqual([
      {
        groupId: pendingGroup,
        marketId,
        maker,
        buy: true,
        tick: 4_410n,
        overlapOwner: 'bootstrap-buy'
      }
    ])
  })

  test('puts a pending intent without a persisted tick at the highest tick', () => {
    expect(
      book({
        ownership: ownership({ bootstrapOffers: [intent(pendingGroup, 90n)] }),
        consumed: { [pendingGroup]: 0n }
      })
    ).toEqual([expect.objectContaining({ groupId: pendingGroup, tick: MAX_TICK })])
  })

  test('drops a consumed or cancelled pending intent', () => {
    expect(
      book({
        ownership: ownership({ bootstrapOffers: [intent(pendingGroup, 90n)] }),
        consumed: { [pendingGroup]: MAX_OFFER_CAP }
      })
    ).toEqual([])
  })

  test('adds the active ladder groups the API has not indexed at their signed ticks', () => {
    expect(
      book({
        ownership: ownership({
          ladderPublications: [
            {
              marketId,
              status: 'reserved',
              quote: {
                marketId,
                centerRateBps: 500n,
                groupMode: 'shared-rung',
                lower: [{ index: 0, rateBps: 400n, assets: 10n }],
                higher: []
              },
              groups: [{ groupId: ladderLow, side: 'lower', rungIndexes: [0], ticks: [4_520n] }]
            }
          ]
        })
      })
    ).toEqual([{ groupId: ladderLow, marketId, maker, buy: false, tick: 4_520n }])
  })

  test('takes own liquidity from chain consumption, dropping spent and cancelled groups', () => {
    const publication = {
      marketId,
      status: 'reserved' as const,
      quote: {
        marketId,
        centerRateBps: 500n,
        groupMode: 'shared-rung' as const,
        lower: [{ index: 0, rateBps: 400n, assets: 10n }],
        higher: []
      },
      groups: [{ groupId: ladderLow, side: 'lower' as const, rungIndexes: [0], ticks: [4_520n] }]
    }
    const withPublication = { ownership: ownership({ ladderPublications: [publication] }) }

    expect(book({ ...withPublication, consumed: { [ladderLow]: 10n } })).toEqual([])
    expect(book({ ...withPublication, consumed: { [ladderLow]: 9n } })).toHaveLength(1)

    const indexed = buyGroup(bootstrapGroup, { maxUnits: 100n, tick: 4_400n })
    expect(book({ groups: [indexed], consumed: { [bootstrapGroup]: 100n } })).toEqual([])
    expect(book({ groups: [indexed], consumed: { [bootstrapGroup]: MAX_OFFER_CAP } })).toEqual([])
    expect(
      book({ groups: [{ ...indexed, consumed: 100n }], consumed: { [bootstrapGroup]: 99n } })
    ).toHaveLength(1)
  })

  test('drops a spent own row the takeable book still lists', () => {
    const indexed = buyGroup(bootstrapGroup, { maxUnits: 100n, tick: 4_400n })
    const apiRow = { groupId: bootstrapGroup, marketId, maker, buy: true, tick: 4_400n }

    expect(
      book({ book: [apiRow], groups: [indexed], consumed: { [bootstrapGroup]: 100n } })
    ).toEqual([])
  })

  test('drops a spent bootstrap intent the takeable book still lists but the groups omit', () => {
    const apiRow = { groupId: pendingGroup, marketId, maker, buy: true, tick: 4_400n }

    expect(
      book({
        book: [apiRow],
        ownership: ownership({
          bootstrapGroupIds: [pendingGroup],
          bootstrapOffers: [{ ...intent(pendingGroup, 100n), tick: 4_400n }]
        }),
        consumed: { [pendingGroup]: 100n }
      })
    ).toEqual([])
  })

  test('fails closed on an indexed group whose consumption was not read', () => {
    expect(() =>
      book({ groups: [buyGroup(bootstrapGroup, { maxUnits: 100n })], consumed: {} })
    ).toThrow(expect.objectContaining({ operation: 'group-consumption-read' }))
  })

  test('keeps only the assessed market, and a third party as itself', () => {
    const thirdPartyRow = { groupId: foreign, marketId, maker: thirdParty, buy: true, tick: 1n }

    expect(
      book({
        book: [thirdPartyRow],
        groups: [buyGroup(bootstrapGroup, { maxUnits: 100n, marketIds: [otherMarketId] })]
      })
    ).toEqual([thirdPartyRow])
  })

  test('fails closed on an owned group the API has not indexed and no intent explains', () => {
    expect(() =>
      book({
        ownership: ownership({ bootstrapGroupIds: [bootstrapGroup] }),
        consumed: { [bootstrapGroup]: 0n }
      })
    ).toThrow(expect.objectContaining({ operation: 'missing-owned-group-intent' }))
  })

  test('lists nothing for an owned group the kernel retired once the API stops indexing it', () => {
    expect(
      book({
        ownership: ownership({
          bootstrapGroupIds: [bootstrapGroup],
          retiredGroupIds: [bootstrapGroup]
        }),
        consumed: { [bootstrapGroup]: 100n }
      })
    ).toEqual([])
  })
})
