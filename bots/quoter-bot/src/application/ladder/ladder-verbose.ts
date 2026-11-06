import type { Hex } from 'viem'

import type { LadderBookSideCrossing } from '../../domain/ladder'

/**
 * One owned ladder group's monotonic consumption, joined to the side and rate it was published at.
 * @remarks `consumed` never decreases for a given `groupId`: replacing a quote reserves fresh group
 * IDs rather than rewriting an existing group, so growth between cycles is taker fills.
 */
export type LadderGroupConsumption = {
  /** Protocol group whose shared consumption cap this describes. */
  groupId: Hex
  /** Market the owning publication was made in. */
  marketId: Hex
  /** Rate side the group was published on. */
  side: 'lower' | 'higher'
  /** Configured rate of the group's rung nearest the center, before tick alignment. */
  groupRateBps: bigint
  /** Protocol `maxUnits` written onto the group. */
  maxUnits: bigint
  /** Monotonic consumed credit units reported by the indexer. */
  consumed: bigint
  /** Remaining units, floored at zero. */
  remainingUnits: bigint
}

/** One side's observed crossing, and whether the replacement cooldown held this cycle. */
export type LadderBookSideCrossingReport = LadderBookSideCrossing & { suppressed: boolean }

/**
 * Result of re-evaluating the resting-ladder crossing from the fresh in-queue book read.
 * @remarks The evidence the cooldown is anchored to: a decision-time crossing is a reason to enter
 * the mutation queue, never a licence to mutate on it.
 */
export type LadderBookReconciliation = {
  /** Block timestamp preparation ran at; the same clock the offers' `start` uses. */
  preparedAtTimestamp: bigint
  bookCrossing: { lower: LadderBookSideCrossing; higher: LadderBookSideCrossing }
  /** `false` when a `book-crossed` replacement found nothing left to clear and mutated nothing. */
  applied: boolean
}
