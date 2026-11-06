import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { OwnedOverlapBookOffer } from '../../../src/domain/intentional-overlap'
import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

import { prepareLadder } from '../../../src/application/engine/ladder-preparation'
import { validateLadderConfig } from '../../../src/domain/ladder'
import {
  groupId,
  indexedGroup,
  maker,
  marketId,
  maturity,
  NOW,
  ratifier,
  reading,
  row,
  thirdParty
} from './preparation.fixtures'

const ladderLow = groupId('a1')
const ladderHigh = groupId('a2')
const pendingGroup = groupId('d1')
const intentless = groupId('e1')
const ownBuy = groupId('c1')
const bidder = groupId('f1')
const asker = groupId('f2')

const config = validateLadderConfig({
  marketId,
  quotePremiumBps: 0n,
  spreadBps: 200n,
  stepBps: 100n,
  rungCount: 1,
  sizeSkewBps: 0n,
  lowerRateBudgetAssets: 1_000n,
  higherRateBudgetAssets: 1_000n,
  targetMarketExposureAssets: 5_000n,
  maximumTotalExposureAssets: 8_000n,
  minimumOfferAssets: 1n,
  groupMode: 'shared-rung',
  loopIntervalSeconds: 60,
  movementToleranceBps: 10n,
  minimumRateBps: 100n,
  maximumRateBps: 2_000n,
  bookCrossedCooldownSeconds: 60
})

const quote = {
  marketId,
  centerRateBps: 500n,
  referenceObservationId: 'hour:1',
  groupMode: 'shared-rung' as const,
  lower: [{ index: 0, rateBps: 400n, assets: 400n }],
  higher: [{ index: 0, rateBps: 600n, assets: 400n }]
}

const publication: OwnedLadderPublication = {
  marketId,
  status: 'confirmed',
  quote,
  groups: [
    { groupId: ladderLow, side: 'lower', rungIndexes: [0], ticks: [4_520n] },
    { groupId: ladderHigh, side: 'higher', rungIndexes: [0], ticks: [4_440n] }
  ]
}

/** The resting ladder: a sell at 4520 and a buy at 4440, indexed and on the takeable book. */
const resting = (book: readonly OwnedOverlapBookOffer[] = []) => ({
  groups: [
    ...indexedGroup(ladderLow, { buy: false, tick: 4_520n, maxUnits: 400n }),
    ...indexedGroup(ladderHigh, { buy: true, tick: 4_440n, maxUnits: 400n })
  ],
  book: [
    row(false, 4_520n, ladderLow, maker, 400n),
    row(true, 4_440n, ladderHigh, maker, 400n),
    ...book
  ],
  ownership: { ladderPublications: [publication] }
})

const prepare = (
  value: ReturnType<typeof reading>,
  request: Partial<Parameters<typeof prepareLadder>[0]['request']> = {}
) =>
  prepareLadder({
    reading: value,
    request: { marketId, block: 100, desired: quote, reason: 'publish', ...request },
    config,
    maker,
    ratifier,
    v0OfferGroupIds: []
  })

const notCrossed = { crossed: false, clearable: true }
const crossedLower = { reason: 'book-crossed' as const, bookCrossedSides: ['lower' as const] }

/** What a prepared publication rests at: its groups' sides and ticks, and the tree's own ticks. */
const restsAt = (prepared: ReturnType<typeof prepareLadder>) => ({
  groups: prepared.publication?.groups.map(group => [group.side, group.ticks]),
  tree: prepared.publication?.tree.offers.map(offer => offer.tick)
})

describe('prepareLadder', () => {
  test('publishes the desired quote at its rates against an empty book', () => {
    const prepared = prepare(reading())

    expect(prepared).toMatchObject({
      reconciliation: {
        preparedAtTimestamp: NOW,
        bookCrossing: { lower: notCrossed, higher: notCrossed },
        applied: true
      },
      bookClearedRungs: { lower: 0, higher: 0 },
      publication: { quote }
    })
    expect(prepared.withdrawnSides).toBeUndefined()
    expect(restsAt(prepared)).toEqual({
      groups: [
        ['lower', [4_520n]],
        ['higher', [4_440n]]
      ],
      tree: [4_520n, 4_440n]
    })
  })

  test('clears a third-party bid through the resting sells on the lower side', () => {
    const prepared = prepare(
      reading(resting([row(true, 4_560n, bidder, thirdParty, 900n)])),
      crossedLower
    )

    expect(prepared).toMatchObject({
      reconciliation: {
        bookCrossing: { lower: { crossed: true, clearable: true }, higher: notCrossed },
        applied: true
      },
      bookClearedRungs: { lower: 1, higher: 0 }
    })
    expect(restsAt(prepared).groups).toEqual([
      ['lower', [4_564n]],
      ['higher', [4_440n]]
    ])
  })

  test('clears a third-party ask through the resting buys on the higher side', () => {
    const prepared = prepare(reading(resting([row(false, 4_420n, asker, thirdParty, 900n)])), {
      reason: 'book-crossed',
      bookCrossedSides: ['higher']
    })

    expect(prepared).toMatchObject({
      reconciliation: { bookCrossing: { lower: notCrossed, higher: { crossed: true } } },
      bookClearedRungs: { lower: 0, higher: 1 }
    })
    expect(restsAt(prepared).groups).toEqual([
      ['lower', [4_520n]],
      ['higher', [4_416n]]
    ])
  })

  test('mutates nothing for a crossing the rate window cannot clear', () => {
    expect(
      prepare(reading(resting([row(true, 4_900n, bidder, thirdParty, 900n)])), crossedLower)
    ).toEqual({
      reconciliation: {
        preparedAtTimestamp: NOW,
        bookCrossing: { lower: { crossed: true, clearable: false }, higher: notCrossed },
        applied: false
      }
    })
  })

  test('ignores a third-party dust bid', () => {
    expect(
      prepare(reading(resting([row(true, 4_560n, bidder, thirdParty, 0n)])), crossedLower)
    ).toEqual({
      reconciliation: {
        preparedAtTimestamp: NOW,
        bookCrossing: { lower: notCrossed, higher: notCrossed },
        applied: false
      }
    })
  })

  test('sees a third party crossing its own sells the API has not indexed', () => {
    const prepared = prepare(
      reading({
        ownership: { ladderPublications: [publication] },
        book: [row(true, 4_560n, bidder, thirdParty, 900n)]
      }),
      crossedLower
    )

    expect(prepared.reconciliation).toEqual({
      preparedAtTimestamp: NOW,
      bookCrossing: { lower: { crossed: true, clearable: true }, higher: notCrossed },
      applied: true
    })
    expect(restsAt(prepared).groups).toEqual([
      ['lower', [4_564n]],
      ['higher', [4_440n]]
    ])
  })

  test('does not see a crossing of its own sell once the chain shows it filled', () => {
    expect(
      prepare(
        reading({
          ownership: { ladderPublications: [publication] },
          book: [row(true, 4_560n, bidder, thirdParty, 900n)],
          consumed: { [ladderLow]: 400n }
        }),
        crossedLower
      ).reconciliation
    ).toEqual({
      preparedAtTimestamp: NOW,
      bookCrossing: { lower: notCrossed, higher: notCrossed },
      applied: false
    })
  })

  test('sees a crossing of its own sell the index has spent but the chain still shows live', () => {
    const prepared = prepare(
      reading({
        groups: indexedGroup(ladderLow, {
          buy: false,
          tick: 4_520n,
          maxUnits: 400n,
          consumed: 400n
        }),
        ownership: { ladderPublications: [publication] },
        book: [row(true, 4_560n, bidder, thirdParty, 900n)],
        consumed: { [ladderLow]: 0n }
      }),
      crossedLower
    )

    expect(prepared.reconciliation?.bookCrossing.lower).toEqual({ crossed: true, clearable: true })
  })

  test('keeps its sells clear of a pending bootstrap buy at the persisted tick', () => {
    const prepared = prepare(
      reading({
        ...resting(),
        ownership: {
          ladderPublications: [publication],
          bootstrapGroupIds: [pendingGroup],
          bootstrapOffers: [
            {
              groupId: pendingGroup,
              marketId,
              assets: 90n,
              rateBps: 420n,
              referenceObservationId: 'hour:2',
              tick: 4_540n
            }
          ]
        },
        consumed: { [pendingGroup]: 3n }
      })
    )

    expect(restsAt(prepared).groups).toEqual([
      ['lower', [4_544n]],
      ['higher', [4_440n]]
    ])
  })

  test('refuses sells against a pending bootstrap buy without a persisted tick', () => {
    expect(() =>
      prepare(
        reading({
          ownership: {
            bootstrapGroupIds: [pendingGroup],
            bootstrapOffers: [
              {
                groupId: pendingGroup,
                marketId,
                assets: 90n,
                rateBps: 420n,
                referenceObservationId: 'hour:2'
              }
            ]
          }
        })
      )
    ).toThrow(expect.objectContaining({ name: 'LadderAdapterError', operation: 'negative-spread' }))
  })

  test('fails closed on an owned group no intent explains, unless it is cancelled', () => {
    expect(() => prepare(reading({ ownership: { bootstrapGroupIds: [intentless] } }))).toThrow(
      expect.objectContaining({
        name: 'BootstrapAdapterError',
        operation: 'missing-owned-group-intent'
      })
    )
    expect(
      prepare(
        reading({
          ownership: { bootstrapGroupIds: [intentless] },
          consumed: { [intentless]: MAX_OFFER_CAP }
        })
      ).reconciliation.applied
    ).toBe(true)
  })

  test('refuses sells that cross an own retained buy the window cannot clear', () => {
    expect(() =>
      prepare(
        reading({
          groups: indexedGroup(ownBuy, { buy: true, tick: 4_900n, maxUnits: 100n }),
          book: [row(true, 4_900n, ownBuy, maker, 100n)]
        })
      )
    ).toThrow(expect.objectContaining({ operation: 'negative-spread' }))
  })

  test('withdraws only the sides the quote holds once the window is empty at the read block', () => {
    expect(
      prepare(reading({ timestamp: maturity - 5n }), { desired: { ...quote, higher: [] } })
    ).toEqual({
      reconciliation: {
        preparedAtTimestamp: maturity - 5n,
        bookCrossing: { lower: notCrossed, higher: notCrossed },
        applied: true
      },
      withdrawnSides: ['lower']
    })
  })

  test('publishes nothing once both sides are withdrawn', () => {
    expect(prepare(reading({ timestamp: maturity - 5n }))).toEqual({
      reconciliation: {
        preparedAtTimestamp: maturity - 5n,
        bookCrossing: { lower: notCrossed, higher: notCrossed },
        applied: true
      },
      withdrawnSides: ['lower', 'higher']
    })
  })

  test('refuses a matured market', () => {
    expect(() => prepare(reading({ timestamp: maturity + 10n }))).toThrow(
      expect.objectContaining({ operation: 'market-matured' })
    )
  })

  describe('on a borrowing ladder', () => {
    const stop = 86_400n
    const cutoff = maturity - stop
    const borrowingConfig = validateLadderConfig({
      ...config,
      debt: { maximumDebtUnits: 1_000n, stopBorrowingBeforeMaturitySeconds: Number(stop) }
    })
    const borrowing = { ...quote, debtCapable: true as const }
    const prepareAt = (timestamp: bigint, desired: typeof quote) =>
      prepareLadder({
        reading: reading({ timestamp }),
        request: { marketId, block: 100, desired, reason: 'publish' },
        config: borrowingConfig,
        maker,
        ratifier,
        v0OfferGroupIds: []
      })

    test('publishes borrowing sells expiring at the cutoff while its own block is open', () => {
      const offers = prepareAt(cutoff - 1n, borrowing).publication?.tree.offers ?? []

      expect(offers.map(offer => [offer.buy, offer.reduceOnly, offer.expiry])).toEqual([
        [false, false, cutoff],
        [true, false, maturity]
      ])
    })

    test.each([cutoff, cutoff + 1n])(
      'refuses a borrowing quote once its own block %s reaches the cutoff',
      timestamp => {
        expect(() => prepareAt(timestamp, borrowing)).toThrow(
          expect.objectContaining({ operation: 'borrowing-closed' })
        )
      }
    )

    test('refuses a closed quote while its own block is still open', () => {
      expect(() => prepareAt(cutoff - 1n, quote)).toThrow(
        expect.objectContaining({ operation: 'borrowing-closed' })
      )
    })

    test('publishes a closed quote as reduce-only sells expiring at maturity past the cutoff', () => {
      const offers = prepareAt(cutoff, quote).publication?.tree.offers ?? []

      expect(offers.map(offer => [offer.buy, offer.reduceOnly, offer.expiry])).toEqual([
        [false, true, maturity],
        [true, false, maturity]
      ])
    })
  })
})
