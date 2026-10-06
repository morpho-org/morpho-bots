import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { ExposureCandidate } from '../../../src/infrastructure/exposure/exposure-admission.utils'
import type {
  ExposureGroup,
  ExposureSnapshot
} from '../../../src/infrastructure/exposure/exposure-snapshot.utils'

import { generateLadder, validateLadderConfig } from '../../../src/domain/ladder'
import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import {
  admitExposureCandidate,
  withheldByAdmission,
  snapshotBootstrapPosition,
  snapshotLadderCapacities
} from '../../../src/infrastructure/exposure/exposure-admission.utils'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'

const marketId: Hex = `0x${'11'.repeat(32)}`
const otherMarketId: Hex = `0x${'12'.repeat(32)}`
const oldGroup: Hex = `0x${'aa'.repeat(32)}`
const candidateGroup: Hex = `0x${'bb'.repeat(32)}`
const otherGroup: Hex = `0x${'cc'.repeat(32)}`

const group = (
  groupId: Hex,
  remainingAssets: bigint,
  state: ExposureGroup['state'] = 'indexed-live',
  marketIds: readonly Hex[] = [marketId],
  remainingCashAssets = remainingAssets
): ExposureGroup => ({ groupId, marketIds, state, remainingAssets, remainingCashAssets })

const snapshotOf = (parameters: Partial<ExposureSnapshot>): ExposureSnapshot => ({
  blockNumber: 10n,
  timestamp: 100n,
  cashBalance: 200n,
  allowance: 200n,
  positions: [
    { marketId, credit: 0n, debt: 0n, lossFactor: 0n },
    { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
  ],
  groups: [],
  ...parameters
})

const ladderCandidate = (buyAssets: bigint): ExposureCandidate => ({
  marketId,
  groupIds: [candidateGroup],
  buyAssets,
  accepted: { acceptedLossFactor: 0n, defaulted: true },
  limits: { kind: 'ladder', targetMarketExposureAssets: 100n, maximumTotalExposureAssets: 1_000n }
})

const bootstrapCandidate = (buyAssets: bigint): ExposureCandidate => ({
  marketId,
  groupIds: [candidateGroup],
  buyAssets,
  accepted: { acceptedLossFactor: 0n, defaulted: true },
  limits: {
    kind: 'bootstrap',
    offerSize: 1_000n,
    creditTarget: 1_000n,
    maximumMarketExposure: 1_000n,
    maximumTotalExposure: 200n
  }
})

describe('admitExposureCandidate', () => {
  test('withholds a ladder replacement whose old buy filled during cancellation', () => {
    const afterFill = snapshotOf({
      positions: [
        { marketId, credit: 100n, debt: 0n, lossFactor: 0n },
        { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
      ],
      cashBalance: 100n,
      allowance: 200n,
      groups: [group(oldGroup, 0n, 'cancelled'), group(candidateGroup, 100n, 'reserved-pending')]
    })

    expect(
      admitExposureCandidate({
        candidate: ladderCandidate(100n),
        snapshot: afterFill,
        adapterError: LadderAdapterError
      })
    ).toEqual({ admitted: false, reason: 'capacity-changed', capacityAssets: 0n })
  })

  test('counts the candidate once while still counting another pending reservation', () => {
    const snapshot = snapshotOf({
      groups: [
        group(candidateGroup, 60n, 'reserved-pending'),
        group(otherGroup, 30n, 'reserved-pending')
      ]
    })

    expect(
      admitExposureCandidate({
        candidate: ladderCandidate(70n),
        snapshot,
        adapterError: LadderAdapterError
      })
    ).toEqual({ admitted: true, capacityAssets: 70n })
    expect(
      admitExposureCandidate({
        candidate: ladderCandidate(71n),
        snapshot,
        adapterError: LadderAdapterError
      }).admitted
    ).toBe(false)
  })

  test('lets the protocol allowance bind below the wallet balance', () => {
    expect(
      admitExposureCandidate({
        candidate: ladderCandidate(50n),
        snapshot: snapshotOf({ cashBalance: 500n, allowance: 40n }),
        adapterError: LadderAdapterError
      })
    ).toEqual({ admitted: false, reason: 'capacity-changed', capacityAssets: 40n })
  })

  test('counts a retained group at its full remaining amount', () => {
    const snapshot = snapshotOf({
      groups: [group(otherGroup, 80n, 'indexed-live', [otherMarketId])]
    })

    expect(
      admitExposureCandidate({
        candidate: bootstrapCandidate(120n),
        snapshot,
        adapterError: BootstrapAdapterError
      })
    ).toEqual({ admitted: true, capacityAssets: 120n })
  })

  test('fails loud when the snapshot has no position for the candidate market', () => {
    expect(() =>
      admitExposureCandidate({
        candidate: bootstrapCandidate(1n),
        snapshot: snapshotOf({ positions: [] }),
        adapterError: BootstrapAdapterError
      })
    ).toThrow(expect.objectContaining({ operation: 'position-unavailable' }))
  })
})

describe('snapshotBootstrapPosition', () => {
  test('counts a partially filled other-market buy at its full committed exposure', () => {
    const position = snapshotBootstrapPosition(
      snapshotOf({
        positions: [
          { marketId, credit: 0n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 50n, debt: 0n, lossFactor: 0n }
        ],
        groups: [group(otherGroup, 50n, 'indexed-live', [otherMarketId])]
      }),
      { marketId, adapterError: BootstrapAdapterError, excludedGroupIds: new Set() }
    )

    expect(position).toEqual({
      credit: 0n,
      cashBalance: 150n,
      marketExposure: 0n,
      totalExposure: 100n
    })
  })

  test('nets wallet cash by what a discounted buy can pay, not by its face units', () => {
    const position = snapshotBootstrapPosition(
      snapshotOf({
        positions: [
          { marketId, credit: 0n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
        ],
        groups: [group(otherGroup, 100n, 'indexed-live', [otherMarketId], 90n)]
      }),
      { marketId, adapterError: BootstrapAdapterError, excludedGroupIds: new Set() }
    )

    expect(position).toMatchObject({ cashBalance: 110n, totalExposure: 100n })
  })

  test('caps spendable cash by an allowance below the wallet balance, net of reservations', () => {
    const position = snapshotBootstrapPosition(
      snapshotOf({
        cashBalance: 500n,
        allowance: 70n,
        groups: [group(otherGroup, 30n, 'indexed-live', [otherMarketId], 20n)]
      }),
      { marketId, adapterError: BootstrapAdapterError, excludedGroupIds: new Set() }
    )

    expect(position.cashBalance).toBe(50n)
  })
})

describe('a fill that drains a finite allowance', () => {
  const ladderConfig = validateLadderConfig({
    marketId,
    quotePremiumBps: 0n,
    spreadBps: 200n,
    stepBps: 100n,
    rungCount: 3,
    sizeSkewBps: 0n,
    lowerRateBudgetAssets: 90n,
    higherRateBudgetAssets: 90n,
    targetMarketExposureAssets: 1_000n,
    maximumTotalExposureAssets: 1_000n,
    minimumOfferAssets: 1n,
    groupMode: 'shared-rung',
    loopIntervalSeconds: 60,
    bookCrossedCooldownSeconds: 180,
    movementToleranceBps: 10n,
    minimumRateBps: 0n,
    maximumRateBps: 1_000n
  })
  const afterFill = snapshotOf({
    cashBalance: 940n,
    allowance: 30n,
    positions: [
      { marketId, credit: 60n, debt: 0n, lossFactor: 0n },
      { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
    ]
  })

  test('sizes the next ladder quote down to the remaining allowance', () => {
    const capacities = snapshotLadderCapacities(afterFill, {
      marketId,
      adapterError: LadderAdapterError,
      excludedGroupIds: new Set(),
      targetMarketExposureAssets: ladderConfig.targetMarketExposureAssets,
      maximumTotalExposureAssets: ladderConfig.maximumTotalExposureAssets
    })
    const quote = generateLadder({ config: ladderConfig, referenceRateBps: 300n, capacities })

    expect(quote.higher.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(30n)
    expect(
      admitExposureCandidate({
        candidate: ladderCandidate(31n),
        snapshot: afterFill,
        adapterError: LadderAdapterError
      })
    ).toEqual({ admitted: false, reason: 'capacity-changed', capacityAssets: 30n })
  })

  test('sizes the next bootstrap buy down to the remaining allowance', () => {
    expect(
      admitExposureCandidate({
        candidate: bootstrapCandidate(31n),
        snapshot: afterFill,
        adapterError: BootstrapAdapterError
      })
    ).toEqual({ admitted: false, reason: 'capacity-changed', capacityAssets: 30n })
    expect(
      admitExposureCandidate({
        candidate: bootstrapCandidate(30n),
        snapshot: afterFill,
        adapterError: BootstrapAdapterError
      })
    ).toEqual({ admitted: true, capacityAssets: 30n })
  })
})

describe('snapshotLadderCapacities', () => {
  const limits = { targetMarketExposureAssets: 100n, maximumTotalExposureAssets: 1_000n }

  test('uses existing credit as lower-rate sale capacity', () => {
    expect(
      snapshotLadderCapacities(
        snapshotOf({
          cashBalance: 100n,
          allowance: 100n,
          positions: [{ marketId, credit: 90n, debt: 0n, lossFactor: 0n }]
        }),
        { marketId, adapterError: LadderAdapterError, excludedGroupIds: new Set(), ...limits }
      )
    ).toEqual({
      lowerRateCapacityAssets: 90n,
      higherRateCapacityAssets: 10n,
      targetMarketCapacityAssets: 100n,
      maximumTotalCapacityAssets: 1_000n,
      cashBalanceAssets: 100n,
      creditAssets: 90n,
      otherMarketCreditAssets: 0n,
      reservedAssets: 0n,
      marketReservedAssets: 0n
    })
  })

  test('reports the wallet balance when the allowance narrows spendable capacity', () => {
    expect(
      snapshotLadderCapacities(snapshotOf({ cashBalance: 100n, allowance: 40n }), {
        marketId,
        adapterError: LadderAdapterError,
        excludedGroupIds: new Set(),
        ...limits
      })
    ).toMatchObject({ higherRateCapacityAssets: 40n, cashBalanceAssets: 100n })
  })

  test('does not reserve the groups being replaced', () => {
    expect(
      snapshotLadderCapacities(snapshotOf({ groups: [group(oldGroup, 30n)] }), {
        marketId,
        adapterError: LadderAdapterError,
        excludedGroupIds: new Set([oldGroup]),
        ...limits
      })
    ).toMatchObject({ reservedAssets: 0n, higherRateCapacityAssets: 100n })
  })

  describe('loss factor', () => {
    const withLossFactor = (lossFactor: bigint) =>
      snapshotOf({
        positions: [
          { marketId, credit: 0n, debt: 0n, lossFactor },
          { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
        ]
      })

    test.each([
      ['ladder', ladderCandidate],
      ['bootstrap', bootstrapCandidate]
    ] as const)('%s admits only on exact equality with the accepted value', (_name, candidate) => {
      const accepted = {
        ...candidate(10n),
        accepted: { acceptedLossFactor: 5n, defaulted: false }
      }

      expect(
        admitExposureCandidate({
          candidate: accepted,
          snapshot: withLossFactor(5n),
          adapterError: LadderAdapterError
        })
      ).toMatchObject({ admitted: true })
      expect(
        admitExposureCandidate({
          candidate: accepted,
          snapshot: withLossFactor(6n),
          adapterError: LadderAdapterError
        })
      ).toEqual({
        admitted: false,
        reason: 'loss-factor-mismatch',
        lossFactor: 6n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'above',
        capacityAssets: 0n
      })
      expect(
        admitExposureCandidate({
          candidate: accepted,
          snapshot: withLossFactor(4n),
          adapterError: LadderAdapterError
        })
      ).toEqual({
        admitted: false,
        reason: 'loss-factor-mismatch',
        lossFactor: 4n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'below',
        capacityAssets: 0n
      })
    })

    test('withholds even a zero-asset candidate once the loss factor moves', () => {
      expect(
        admitExposureCandidate({
          candidate: ladderCandidate(0n),
          snapshot: withLossFactor(1n),
          adapterError: LadderAdapterError
        })
      ).toMatchObject({ admitted: false, reason: 'loss-factor-mismatch' })
    })

    test('projects each rejection into its withholding', () => {
      expect(withheldByAdmission({ admitted: true, capacityAssets: 1n })).toBeUndefined()
      expect(
        withheldByAdmission({ admitted: false, reason: 'capacity-changed', capacityAssets: 1n })
      ).toEqual({ reason: 'capacity-changed' })
      expect(
        withheldByAdmission({ admitted: false, reason: 'price-changed', capacityAssets: 1n })
      ).toEqual({ reason: 'price-changed' })
      expect(
        withheldByAdmission({
          admitted: false,
          reason: 'loss-factor-mismatch',
          lossFactor: 4n,
          acceptedLossFactor: 5n,
          defaulted: false,
          direction: 'below',
          capacityAssets: 0n
        })
      ).toEqual({
        reason: 'loss-factor-mismatch',
        lossFactor: 4n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'below'
      })
    })
  })
})

describe('admitExposureCandidate inventory skew', () => {
  const skewConfig = validateLadderConfig({
    marketId,
    quotePremiumBps: 0n,
    spreadBps: 200n,
    stepBps: 100n,
    rungCount: 3,
    sizeSkewBps: 0n,
    lowerRateBudgetAssets: 30n,
    higherRateBudgetAssets: 30n,
    targetMarketExposureAssets: 100n,
    maximumTotalExposureAssets: 1_000n,
    minimumOfferAssets: 1n,
    groupMode: 'shared-rung',
    loopIntervalSeconds: 60,
    bookCrossedCooldownSeconds: 180,
    movementToleranceBps: 10n,
    minimumRateBps: 0n,
    maximumRateBps: 1_000n,
    inventorySkew: { unitsPerStep: 10n }
  })
  const planAt = (creditAssets: bigint, referenceRateBps = 300n) =>
    generateLadder({ config: skewConfig, referenceRateBps, capacities: { creditAssets } })
  const snapshotWithCredit = (credit: bigint) =>
    snapshotOf({
      positions: [
        { marketId, credit, debt: 0n, lossFactor: 0n },
        { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
      ]
    })
  const admit = (quote: ReturnType<typeof planAt>, credit: bigint) =>
    admitExposureCandidate({
      candidate: {
        ...ladderCandidate(30n),
        limits: {
          kind: 'ladder',
          targetMarketExposureAssets: 100n,
          maximumTotalExposureAssets: 1_000n,
          buyPricing: { config: skewConfig, quote }
        }
      },
      snapshot: snapshotWithCredit(credit),
      adapterError: LadderAdapterError
    })

  test('withholds price-changed when fills during cancellation raise the fresh skew', () => {
    expect(admit(planAt(10n), 20n)).toEqual({
      admitted: false,
      reason: 'price-changed',
      capacityAssets: 80n
    })
  })

  test('admits when the fresh skew is equal or lower', () => {
    expect(admit(planAt(20n), 20n)).toEqual({ admitted: true, capacityAssets: 80n })
    expect(admit(planAt(20n), 10n)).toEqual({ admitted: true, capacityAssets: 90n })
  })

  test('withholds a buy planned at the maximum that a higher fresh skew would omit', () => {
    const atMaximum = planAt(10n, 800n)
    expect(atMaximum.higher).toEqual([{ index: 0, rateBps: 1_000n, assets: 10n }])
    expect(
      generateLadder({
        config: skewConfig,
        referenceRateBps: 800n,
        capacities: { creditAssets: 11n }
      }).higher
    ).toEqual([])

    expect(admit(atMaximum, 11n)).toEqual({
      admitted: false,
      reason: 'price-changed',
      capacityAssets: 89n
    })
    expect(admit(atMaximum, 10n)).toEqual({ admitted: true, capacityAssets: 90n })
  })

  test('has nothing to reprice when every planned buy was already omitted', () => {
    const omitted = planAt(10n, 900n)
    expect(omitted.higher).toEqual([])

    expect(admit(omitted, 50n)).toEqual({ admitted: true, capacityAssets: 50n })
  })

  test('ignores pricing for a candidate carrying none', () => {
    expect(
      admitExposureCandidate({
        candidate: ladderCandidate(30n),
        snapshot: snapshotWithCredit(50n),
        adapterError: LadderAdapterError
      })
    ).toEqual({ admitted: true, capacityAssets: 50n })
  })

  test('converges: republishing at the fresh credit is admitted once fills stop', () => {
    let credit = 0n
    let quote = planAt(credit)
    const outcomes: string[] = []
    for (const fill of [10n, 10n, 0n]) {
      credit += fill
      const admission = admit(quote, credit)
      outcomes.push(admission.admitted ? 'admitted' : admission.reason)
      quote = planAt(credit)
    }

    expect(outcomes).toEqual(['price-changed', 'price-changed', 'admitted'])
  })
})
