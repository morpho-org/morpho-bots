import type { Hex } from 'viem'

import { MAX_OFFER_CAP, TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

import {
  exposureSnapshot,
  snapshotLadderCapacities
} from '../../../src/application/engine/exposure'
import { MAX_LOSS_FACTOR } from '../../../src/domain/loss-factor'
import { LadderAdapterError } from '../../../src/errors'
import {
  accounting,
  buyGroup,
  intent,
  maker,
  marketId,
  otherMarketId,
  world
} from './world.fixtures'

const groupA: Hex = `0x${'aa'.repeat(32)}`
const groupB: Hex = `0x${'bb'.repeat(32)}`
const groupC: Hex = `0x${'cc'.repeat(32)}`

const snapshot = (parameters: Parameters<typeof world>[0]) =>
  exposureSnapshot(world(parameters), accounting, LadderAdapterError)

describe('exposureSnapshot', () => {
  test('assembles every accounting market, the cash, and the block from one world', () => {
    const result = snapshot({ groups: [buyGroup(groupA, { maxUnits: 10n })] })

    expect(result).toMatchObject({
      blockNumber: 42n,
      timestamp: 1_000_000n,
      cashBalance: 500n,
      allowance: 400n
    })
    expect(result.positions).toEqual([
      { marketId, credit: 420n, debt: 0n, lossFactor: 0n },
      { marketId: otherMarketId, credit: 30n, debt: 0n, lossFactor: 0n }
    ])
  })

  test('fails as the first failed read it needs', () => {
    expect(() => snapshot({ cash: { ok: false, errorName: 'HttpRequestError' } })).toThrow(
      expect.objectContaining({ failure: { ok: false, errorName: 'HttpRequestError' } })
    )
  })

  test('fails closed when an accounting market has no position read', () => {
    const base = world()
    expect(() =>
      exposureSnapshot(
        { ...base, positions: { [marketId]: base.positions[marketId]! } },
        accounting,
        LadderAdapterError
      )
    ).toThrow(expect.objectContaining({ operation: 'position-unavailable' }))
  })

  test('fails closed on a loss factor above uint128', () => {
    const base = world()
    const position = base.positions[marketId]!
    expect(() =>
      exposureSnapshot(
        {
          ...base,
          positions: {
            ...base.positions,
            [marketId]: position.ok
              ? { ok: true, value: { ...position.value, lossFactor: MAX_LOSS_FACTOR + 1n } }
              : position
          }
        },
        accounting,
        LadderAdapterError
      )
    ).toThrow(expect.objectContaining({ operation: 'loss-factor-read' }))
  })

  test('fails closed on a known group whose consumption the poll did not read', () => {
    const base = world({ groups: [buyGroup(groupA, { maxUnits: 10n })] })
    expect(() =>
      exposureSnapshot(
        { ...base, consumed: { ok: true, value: {} } },
        accounting,
        LadderAdapterError
      )
    ).toThrow(expect.objectContaining({ operation: 'group-consumption-read' }))
  })

  test('takes consumption from the chain when the indexer is ahead of it', () => {
    const result = snapshot({
      groups: [buyGroup(groupA, { maxUnits: 100n, consumed: 80n })],
      consumed: { [groupA]: 30n }
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'indexed-live',
        remainingAssets: 70n,
        remainingCashAssets: 70n
      }
    ])
  })

  test('bounds a discounted buy by its cash at its tick, and an unindexed one at face', () => {
    const tick = 4_440n
    const result = snapshot({
      groups: [buyGroup(groupA, { maxUnits: 1_000_001n, consumed: 10n, tick })],
      ownership: { bootstrapOffers: [intent(groupB, 40n, otherMarketId)] },
      consumed: { [groupA]: 10n }
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'indexed-live',
        remainingAssets: 999_991n,
        remainingCashAssets: MathLib.mulDiv(999_991n, TickLib.tickToPrice(tick), MathLib.WAD, 'Up')
      },
      {
        groupId: groupB,
        marketIds: [otherMarketId],
        state: 'reserved-pending',
        remainingAssets: 40n,
        remainingCashAssets: 40n
      }
    ])
  })

  test('fails closed on a live or used-up cash-capped buy, and accepts a cancelled one', () => {
    const group = buyGroup(groupA, { maxAssets: 100n })
    expect(() => snapshot({ groups: [group] })).toThrow(
      expect.objectContaining({ operation: 'cash-capped-buy-group' })
    )
    expect(() => snapshot({ groups: [group], consumed: { [groupA]: 100n } })).toThrow(
      expect.objectContaining({ operation: 'cash-capped-buy-group' })
    )
    expect(
      snapshot({ groups: [group], consumed: { [groupA]: MAX_OFFER_CAP } }).groups.map(
        item => item.state
      )
    ).toEqual(['cancelled'])
  })

  test('counts a group at the cancellation sentinel as zero, never a negative reservation', () => {
    expect(
      snapshot({
        groups: [buyGroup(groupA, { maxUnits: 100n })],
        consumed: { [groupA]: MAX_OFFER_CAP }
      }).groups
    ).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'cancelled',
        remainingAssets: 0n,
        remainingCashAssets: 0n
      }
    ])
    expect(
      snapshot({ groups: [buyGroup(groupA, { maxUnits: 100n })], consumed: { [groupA]: 150n } })
        .groups[0]?.remainingAssets
    ).toBe(0n)
  })

  test('fails closed on an unindexed, uncancelled owned group without an intent', () => {
    expect(() => snapshot({ ownership: { bootstrapGroupIds: [groupB] } })).toThrow(
      expect.objectContaining({ operation: 'missing-owned-group-intent' })
    )
    expect(
      snapshot({
        ownership: { bootstrapGroupIds: [groupB] },
        consumed: { [groupB]: MAX_OFFER_CAP }
      }).groups
    ).toEqual([
      {
        groupId: groupB,
        marketIds: [],
        state: 'cancelled',
        remainingAssets: 0n,
        remainingCashAssets: 0n
      }
    ])
  })

  test('still fails closed on a retired group whose consumption is unread or whose cap is cash', () => {
    const base = world({ ownership: { bootstrapGroupIds: [groupB], retiredGroupIds: [groupB] } })
    expect(() =>
      exposureSnapshot(
        { ...base, consumed: { ok: true, value: {} } },
        accounting,
        LadderAdapterError
      )
    ).toThrow(expect.objectContaining({ operation: 'group-consumption-read' }))
    expect(() =>
      snapshot({
        groups: [buyGroup(groupB, { maxAssets: 100n })],
        ownership: { retiredGroupIds: [groupB] }
      })
    ).toThrow(expect.objectContaining({ operation: 'cash-capped-buy-group' }))
  })

  test('reserves nothing for a group the kernel retired, whether or not the index still lists it', () => {
    const retired = {
      groupId: groupB,
      marketIds: [],
      state: 'retired',
      remainingAssets: 0n,
      remainingCashAssets: 0n
    }
    expect(
      snapshot({
        ownership: { bootstrapGroupIds: [groupB], retiredGroupIds: [groupB] },
        consumed: { [groupB]: 40n }
      }).groups
    ).toEqual([retired])
    expect(
      snapshot({
        groups: [buyGroup(groupB, { maxUnits: 100n, consumed: 10n })],
        ownership: { bootstrapGroupIds: [groupB], retiredGroupIds: [groupB] },
        consumed: { [groupB]: 10n }
      }).groups
    ).toEqual([{ ...retired, marketIds: [marketId] }])
  })

  test('leaves an unretired group beside a retired one as it was', () => {
    expect(
      snapshot({
        groups: [buyGroup(groupA, { maxUnits: 100n })],
        ownership: { bootstrapGroupIds: [groupB], retiredGroupIds: [groupB] },
        consumed: { [groupA]: 30n, [groupB]: 0n }
      }).groups
    ).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'indexed-live',
        remainingAssets: 70n,
        remainingCashAssets: 70n
      },
      {
        groupId: groupB,
        marketIds: [],
        state: 'retired',
        remainingAssets: 0n,
        remainingCashAssets: 0n
      }
    ])
  })

  test('fails closed when the indexer and durable intent disagree on a cap kind', () => {
    expect(() =>
      snapshot({
        groups: [buyGroup(groupA, { maxAssets: 100n })],
        ownership: { bootstrapOffers: [intent(groupA, 100n)] }
      })
    ).toThrow(expect.objectContaining({ operation: 'group-ownership-state' }))
  })

  test('reserves the larger of indexed and durable caps and ignores sell-only groups', () => {
    const sellOnly: MakerOfferGroup = {
      id: groupC,
      cap: { kind: 'assets', maximum: 90n },
      consumed: 0n,
      offers: [{ marketId, maker, buy: false, tick: 1n }]
    }

    expect(
      snapshot({
        groups: [
          buyGroup(groupA, { maxUnits: 60n, marketIds: [marketId] }),
          buyGroup(groupA, { maxUnits: 60n, marketIds: [otherMarketId] }),
          sellOnly
        ],
        ownership: { bootstrapOffers: [intent(groupA, 999n), intent(groupC, 999n)] }
      }).groups
    ).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId, otherMarketId],
        state: 'indexed-live',
        remainingAssets: 999n,
        remainingCashAssets: 999n
      }
    ])
  })

  test('reserves a ladder publication at its higher-side rungs', () => {
    expect(
      snapshot({
        ownership: {
          ladderPublications: [
            {
              marketId,
              status: 'reserved',
              quote: {
                marketId,
                centerRateBps: 500n,
                groupMode: 'shared-rung',
                lower: [{ index: 0, rateBps: 400n, assets: 7n }],
                higher: [
                  { index: 0, rateBps: 600n, assets: 5n },
                  { index: 1, rateBps: 700n, assets: 6n }
                ]
              },
              groups: [
                { groupId: groupA, side: 'lower', rungIndexes: [0], ticks: [1n] },
                { groupId: groupB, side: 'higher', rungIndexes: [0, 1], ticks: [2n, 3n] }
              ]
            }
          ]
        }
      }).groups
    ).toEqual([
      {
        groupId: groupB,
        marketIds: [marketId],
        state: 'reserved-pending',
        remainingAssets: 11n,
        remainingCashAssets: 11n
      }
    ])
  })
})

describe('snapshotLadderCapacities', () => {
  test('sizes from spendable cash, credit, and every reservation not being replaced', () => {
    const result = snapshot({
      groups: [buyGroup(groupA, { maxUnits: 50n }), buyGroup(groupB, { maxUnits: 20n })]
    })

    expect(
      snapshotLadderCapacities(result, {
        marketId,
        adapterError: LadderAdapterError,
        excludedGroupIds: new Set([groupB]),
        targetMarketExposureAssets: 1_000n,
        maximumTotalExposureAssets: 2_000n
      })
    ).toMatchObject({
      lowerRateCapacityAssets: 420n,
      higherRateCapacityAssets: 350n,
      cashBalanceAssets: 500n,
      creditAssets: 420n,
      otherMarketCreditAssets: 30n,
      reservedAssets: 50n,
      marketReservedAssets: 50n
    })
  })
})

describe('borrowing sell capacities', () => {
  test.each([
    { credit: 0n, debt: 0n, assets: 90n, limit: 80n, expected: 80n },
    { credit: 1_000n, debt: 25n, assets: 90n, limit: 80n, expected: 55n },
    { credit: 1_000n, debt: 85n, assets: 90n, limit: 80n, expected: 0n },
    { credit: 1_000n, debt: 0n, assets: 11n, limit: 80n, expected: 9n }
  ])(
    'uses debt headroom alone: $credit credit, $debt debt, $assets collateral',
    ({ credit, debt, assets, limit, expected }) => {
      const base = world()
      const source = base.positions[marketId]!
      if (!source.ok) throw new Error('expected position')
      const result = snapshot({
        positions: {
          ...base.positions,
          [marketId]: {
            ok: true,
            value: {
              ...source.value,
              credit,
              debt,
              loanCollateral: { assets, lltv: 900_000_000_000_000_000n }
            }
          }
        }
      })
      expect(result.positions[0]?.loanCollateral).toEqual({
        assets,
        lltv: 900_000_000_000_000_000n
      })
      expect(
        snapshotLadderCapacities(result, {
          marketId,
          adapterError: LadderAdapterError,
          excludedGroupIds: new Set(),
          targetMarketExposureAssets: 2_000n,
          maximumTotalExposureAssets: 3_000n,
          debt: { maximumDebtUnits: limit, stopBorrowingBeforeMaturitySeconds: 0 },
          maturity: 2_000_000n
        })
      ).toMatchObject({
        lowerRateCapacityAssets: expected,
        debtAssets: debt,
        debtCeilingAssets: assets === 11n ? 9n : 80n
      })
    }
  )

  test('grants no borrowing capacity without a loan collateral slot', () => {
    expect(
      snapshotLadderCapacities(snapshot({}), {
        marketId,
        adapterError: LadderAdapterError,
        excludedGroupIds: new Set(),
        targetMarketExposureAssets: 2_000n,
        maximumTotalExposureAssets: 3_000n,
        debt: { maximumDebtUnits: 80n, stopBorrowingBeforeMaturitySeconds: 0 },
        maturity: 2_000_000n
      })
    ).toMatchObject({ lowerRateCapacityAssets: 0n, debtAssets: 0n, debtCeilingAssets: 0n })
  })

  test.each([
    ['at the cutoff', 1_000_100n],
    ['past the cutoff', 1_000_050n],
    ['with no maturity', undefined]
  ])(
    'sizes sells by credit and still reports debt once borrowing is closed: %s',
    (_name, maturity) => {
      const base = world()
      const source = base.positions[marketId]!
      if (!source.ok) throw new Error('expected position')
      const result = snapshot({
        positions: {
          ...base.positions,
          [marketId]: {
            ok: true,
            value: {
              ...source.value,
              debt: 25n,
              loanCollateral: { assets: 90n, lltv: 1_000_000_000_000_000_000n }
            }
          }
        }
      })
      const parameters = {
        marketId,
        adapterError: LadderAdapterError,
        excludedGroupIds: new Set<Hex>(),
        targetMarketExposureAssets: 2_000n,
        maximumTotalExposureAssets: 3_000n
      }

      expect(
        snapshotLadderCapacities(result, {
          ...parameters,
          debt: { maximumDebtUnits: 80n, stopBorrowingBeforeMaturitySeconds: 100 },
          ...(maturity === undefined ? {} : { maturity })
        })
      ).toStrictEqual({
        ...snapshotLadderCapacities(result, parameters),
        debtAssets: 25n,
        debtCeilingAssets: 80n
      })
    }
  )
})
