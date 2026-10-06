import type { Hex } from 'viem'

import { zeroFloorSub } from '@repo/utils'

import type {
  OperatorAdapterErrorClass,
  OperatorAdapterOperation
} from '../../application/monitoring/operator-error-name.utils'
import type { LadderQuoteSet, ValidLadderConfig } from '../../domain/ladder'
import type { LendHalt } from '../../domain/loss-factor'
import type { BootstrapConfig, BootstrapPosition } from '../../domain/position-bootstrap'
import type { ExposureSnapshot } from './exposure-snapshot.utils'

import {
  operatorAdapterOperation,
  operatorErrorName
} from '../../application/monitoring/operator-error-name.utils'
import { higherRungsRepriced } from '../../domain/ladder'
import { lendHalt } from '../../domain/loss-factor'
import { bootstrapSizeCapacity } from '../../domain/position-bootstrap'
import { calculateLadderCapacities } from '../ladder/ladder-capacity.utils'
import { spendableCash } from './exposure-snapshot.utils'

/**
 * Why a prepared publication was released unpublished after its replaced groups were cancelled.
 * @remarks `capacity-changed` means a fresh snapshot no longer admits it; `price-changed` means the
 * snapshot's credit would publish a lend rung dearer than planned; `loss-factor-mismatch`
 * means the market's loss factor at that snapshot differs from the accepted value;
 * `snapshot-unavailable` means no snapshot at or after the cancellations could be read, so
 * admission failed closed.
 */
export type PublicationWithheld =
  | { reason: 'capacity-changed' }
  | { reason: 'price-changed' }
  | ({ reason: 'loss-factor-mismatch' } & LendHalt)
  | {
      reason: 'snapshot-unavailable'
      errorName: string
      /** Allowlisted operation of the underlying snapshot failure, when it carried one. */
      snapshotErrorOperation?: OperatorAdapterOperation
    }

/**
 * Classifies an admission failure as a sanitized `snapshot-unavailable` withholding.
 * @param error - Failure thrown while reading or admitting against the snapshot.
 * @returns The withholding with an allowlisted error name and, when present, operation.
 */
export const snapshotUnavailable = (error: unknown): PublicationWithheld => {
  const snapshotErrorOperation = operatorAdapterOperation(error)
  return {
    reason: 'snapshot-unavailable',
    errorName: operatorErrorName(error),
    ...(snapshotErrorOperation ? { snapshotErrorOperation } : {})
  }
}

/**
 * Projects a withholding's underlying snapshot operation into an optional result field.
 * @param withheld - A withheld publication.
 * @returns `{ snapshotErrorOperation }` when one was recorded, otherwise an empty object.
 */
export const snapshotErrorOperationField = (withheld: PublicationWithheld) =>
  'snapshotErrorOperation' in withheld && withheld.snapshotErrorOperation !== undefined
    ? { snapshotErrorOperation: withheld.snapshotErrorOperation }
    : {}

type ExcludedGroups = { excludedGroupIds: ReadonlySet<Hex> }

type LadderExposureLimits = {
  targetMarketExposureAssets: bigint
  maximumTotalExposureAssets: bigint
}

type LadderBuyPricing = {
  /** Configuration and planned quote whose lend rates the snapshot's credit must not raise. */
  buyPricing?: {
    config: ValidLadderConfig
    quote: Pick<LadderQuoteSet, 'centerRateBps' | 'higher' | 'higherSkewBps'>
  }
}

type BootstrapExposureLimits = Pick<
  BootstrapConfig,
  'offerSize' | 'creditTarget' | 'maximumMarketExposure' | 'maximumTotalExposure'
>

/**
 * One prepared buy publication checked against a snapshot before it may be published.
 * @remarks `groupIds` is the candidate's own durable reservation, which admission excludes so the
 * candidate is counted exactly once, as `buyAssets`.
 */
export type ExposureCandidate = {
  marketId: Hex
  groupIds: readonly Hex[]
  buyAssets: bigint
  /** Operator-accepted loss factor of the candidate market, and whether it was defaulted. */
  accepted: { acceptedLossFactor: bigint; defaulted: boolean }
  limits:
    | ({ kind: 'ladder' } & LadderExposureLimits & LadderBuyPricing)
    | ({ kind: 'bootstrap' } & BootstrapExposureLimits)
}

const marketPosition = (
  snapshot: ExposureSnapshot,
  marketId: Hex,
  adapterError: OperatorAdapterErrorClass
) => {
  const position = snapshot.positions.find(item => item.marketId === marketId)
  if (!position) throw new adapterError('position-unavailable')
  return position
}

const marketCredit = (
  snapshot: ExposureSnapshot,
  marketId: Hex,
  adapterError: OperatorAdapterErrorClass
) => marketPosition(snapshot, marketId, adapterError).credit

const reservations = (snapshot: ExposureSnapshot, excludedGroupIds: ReadonlySet<Hex>) =>
  snapshot.groups
    .filter(group => group.remainingAssets > 0n && !excludedGroupIds.has(group.groupId))
    .map(group => ({
      id: group.groupId,
      marketIds: group.marketIds,
      assets: group.remainingAssets,
      cashAssets: group.remainingCashAssets
    }))

/**
 * Derives ladder capacities from one snapshot.
 * @param snapshot - Coherent exposure snapshot.
 * @param parameters - Market, exposure limits, groups not to reserve, and the adapter error.
 * @returns `calculateLadderCapacities` over the snapshot's spendable cash and reservations.
 * @throws `position-unavailable` when the snapshot holds no position for the market.
 */
export const snapshotLadderCapacities = (
  snapshot: ExposureSnapshot,
  parameters: { marketId: Hex; adapterError: OperatorAdapterErrorClass } & LadderExposureLimits &
    ExcludedGroups
) => {
  const currentCredit = marketCredit(snapshot, parameters.marketId, parameters.adapterError)
  return calculateLadderCapacities({
    marketId: parameters.marketId,
    balance: spendableCash(snapshot),
    walletBalance: snapshot.cashBalance,
    currentCredit,
    otherMarketCredit: snapshot.positions
      .filter(position => position.marketId !== parameters.marketId)
      .reduce((sum, position) => sum + position.credit, 0n),
    creditSaleCapacityAssets: currentCredit,
    targetMarketExposureAssets: parameters.targetMarketExposureAssets,
    maximumTotalExposureAssets: parameters.maximumTotalExposureAssets,
    reservations: reservations(snapshot, parameters.excludedGroupIds)
  })
}

/**
 * Derives the bootstrap sizing position from one snapshot.
 * @param snapshot - Coherent exposure snapshot.
 * @param parameters - Market, groups not to reserve, and the adapter error.
 * @returns Market credit, {@link spendableCash} net of reservations, and market and total exposure.
 * @throws `position-unavailable` when the snapshot holds no position for the market.
 */
export const snapshotBootstrapPosition = (
  snapshot: ExposureSnapshot,
  parameters: { marketId: Hex; adapterError: OperatorAdapterErrorClass } & ExcludedGroups
): BootstrapPosition => {
  const credit = marketCredit(snapshot, parameters.marketId, parameters.adapterError)
  const reserved = reservations(snapshot, parameters.excludedGroupIds)
  const reservedAssets = reserved.reduce((sum, item) => sum + item.assets, 0n)
  const reservedCashAssets = reserved.reduce((sum, item) => sum + item.cashAssets, 0n)
  const marketReservedAssets = reserved
    .filter(item => item.marketIds.includes(parameters.marketId))
    .reduce((sum, item) => sum + item.assets, 0n)
  return {
    credit,
    cashBalance: zeroFloorSub(spendableCash(snapshot), reservedCashAssets),
    marketExposure: credit + marketReservedAssets,
    totalExposure:
      snapshot.positions.reduce((sum, position) => sum + position.credit, 0n) + reservedAssets
  }
}

/** Whether a prepared buy was admitted, and the capacity it was measured against. */
export type ExposureAdmission =
  | { admitted: true; capacityAssets: bigint }
  | { admitted: false; reason: 'capacity-changed' | 'price-changed'; capacityAssets: bigint }
  | ({ admitted: false; reason: 'loss-factor-mismatch'; capacityAssets: 0n } & LendHalt)

/**
 * Decides whether a prepared buy still fits every configured limit at the snapshot block.
 * @param parameters - Candidate, snapshot, and the strategy's adapter error.
 * @returns The admission; a market whose loss factor differs from the accepted value in either
 * direction has zero buy capacity, and a ladder candidate whose snapshot credit raises a planned
 * lend rate is `price-changed`.
 * @throws `position-unavailable` when the snapshot holds no position for the candidate market.
 * @remarks The single exposure-admission seam shared by both strategies. Every other known group's
 * remaining reservation counts; only the candidate's own groups are excluded.
 */
export const admitExposureCandidate = (parameters: {
  candidate: ExposureCandidate
  snapshot: ExposureSnapshot
  adapterError: OperatorAdapterErrorClass
}): ExposureAdmission => {
  const { candidate, snapshot, adapterError } = parameters
  const halt = lendHalt({
    lossFactor: marketPosition(snapshot, candidate.marketId, adapterError).lossFactor,
    ...candidate.accepted
  })
  if (halt) return { admitted: false, reason: 'loss-factor-mismatch', capacityAssets: 0n, ...halt }
  const excludedGroupIds = new Set(candidate.groupIds)
  const capacityAssets =
    candidate.limits.kind === 'ladder'
      ? snapshotLadderCapacities(snapshot, {
          marketId: candidate.marketId,
          adapterError,
          excludedGroupIds,
          targetMarketExposureAssets: candidate.limits.targetMarketExposureAssets,
          maximumTotalExposureAssets: candidate.limits.maximumTotalExposureAssets
        }).higherRateCapacityAssets
      : bootstrapSizeCapacity(
          candidate.limits,
          snapshotBootstrapPosition(snapshot, {
            marketId: candidate.marketId,
            adapterError,
            excludedGroupIds
          })
        ).assets
  if (candidate.buyAssets > capacityAssets) {
    return { admitted: false, reason: 'capacity-changed', capacityAssets }
  }
  const pricing = candidate.limits.kind === 'ladder' ? candidate.limits.buyPricing : undefined
  if (
    pricing &&
    higherRungsRepriced(
      pricing.config,
      pricing.quote,
      marketCredit(snapshot, candidate.marketId, adapterError)
    )
  ) {
    return { admitted: false, reason: 'price-changed', capacityAssets }
  }
  return { admitted: true, capacityAssets }
}

/**
 * Projects a rejected admission into the withholding a make adapter reports.
 * @param admission - Admission result from {@link admitExposureCandidate}.
 * @returns The withholding, or `undefined` when the candidate was admitted.
 */
export const withheldByAdmission = (
  admission: ExposureAdmission
): PublicationWithheld | undefined => {
  if (admission.admitted) return undefined
  if (admission.reason === 'capacity-changed' || admission.reason === 'price-changed') {
    return { reason: admission.reason }
  }
  const { admitted: _admitted, capacityAssets: _capacityAssets, ...withheld } = admission
  return withheld
}
