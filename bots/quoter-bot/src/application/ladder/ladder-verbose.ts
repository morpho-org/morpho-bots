import type { Hex } from 'viem'

import type {
  LadderBookSideCrossing,
  LadderConfig,
  LadderDiagnostics,
  LadderMarketState,
  LadderQuoteSet
} from '../../domain/ladder/ladder'

/** Ladder transaction identity shared by immediate submission and confirmed-result records. */
export type LadderSubmittedTransaction = {
  /** Protocol mutation represented by the transaction. */
  operation: 'cancel' | 'ratify' | 'publish'
  /** Canonical transaction hash returned by the wallet client. */
  txHash: Hex
}

/** Immediate safe event emitted after a ladder transaction enters the provider submission path. */
export type LadderTransactionSubmittedEvent = LadderSubmittedTransaction & {
  /** Stable JSON Lines event discriminator. */
  event: 'ladder.transaction-submitted'
  /** Market-local reconciliation scope; omitted for strategy-wide cleanup cancellations. */
  marketId?: Hex
}

/** Optional observer notified immediately after the wallet returns a ladder transaction hash. */
export type LadderTransactionSubmittedObserver = (
  transaction: LadderSubmittedTransaction
) => void | Promise<void>

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
  /** Protocol consumption cap written onto the group. */
  maxAssets: bigint
  /** Monotonic consumed assets reported by the indexer. */
  consumed: bigint
  /** Remaining capacity, floored at zero. */
  remainingAssets: bigint
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

/** What read-only validation learned about a publication it would have made. */
export type LadderReadOnlyValidation = {
  reconciliation: LadderBookReconciliation
  bookClearedRungs?: { lower: number; higher: number }
}

/** Result returned by a live or read-only ladder make adapter. */
export type LadderMakeResult =
  | void
  | 'logged'
  | {
      /** Confirmed transactions submitted by this mutation request, in submission order. */
      submittedTransactions: readonly LadderSubmittedTransaction[]
      /** Rungs per side the opposing book repriced, when a publication was prepared. */
      bookClearedRungs?: { lower: number; higher: number }
      /** Marks a dry run that validated and logged the request instead of submitting it. */
      logged?: true
      /** The in-queue crossing recheck, when a desired publication was assessed. */
      reconciliation?: LadderBookReconciliation
    }

/** Complete provider and active-quote projection shown for a verbose ladder check. */
export type LadderVerboseState =
  | {
      /** Indicates that a fresh market and active-quote snapshot was read successfully. */
      status: 'observed'
      /** Current side, market, and strategy-total fresh capacities. */
      market: LadderMarketState
      /** Current strategy-owned quote set, when active roots remain live. */
      activeQuote?: LadderQuoteSet
    }
  | {
      /** Indicates that a provider could not return a usable complete snapshot. */
      status: 'failed'
      /** Sanitized error classification without provider payloads or credentials. */
      errorName: string
    }
  | {
      /** Indicates that safety validation deliberately prevented a provider read. */
      status: 'not-read'
      /** Stable explanation for suppressing the read. */
      reason: 'configuration-invalid'
    }

/** Opt-in diagnostic context attached to one ladder market result. */
export type LadderVerboseDetails = {
  /** Complete validated or rejected market ladder configuration. */
  config: LadderConfig
  /** Fresh market capacities and active quote observed before the decision. */
  currentState: LadderVerboseState
  /** Fresh reference rate used to derive the effective ladder center, when available. */
  referenceRateBps?: bigint
  /** Fresh seconds to maturity read beside the reference, when a maturity premium requires it. */
  secondsToMaturity?: bigint
  /** Resolved time-to-maturity premium included in `targetRateBps`, when configured. */
  maturityPremiumBps?: bigint
  /** Reference rate plus configured quote and maturity premiums, when derivation was possible. */
  targetRateBps?: bigint
  /** Exact desired lower/higher quote set, when decision derivation succeeded. */
  ladderOffer?: LadderQuoteSet
  /** Stable reconciliation reason selected by the application workflow. */
  decision?: 'publish' | 'recenter' | 'resize' | 'rest' | 'book-crossed' | 'matured'
  /** Pre-decision per-side crossing, and whether its cooldown suppressed a replacement. */
  bookCrossing?: { lower: LadderBookSideCrossingReport; higher: LadderBookSideCrossingReport }
  /** The make adapter's in-queue crossing recheck, when it assessed one. */
  bookReconciliation?: LadderBookReconciliation
  /** Confirmed transactions submitted for this market check, in submission order. */
  submittedTransactions?: readonly LadderSubmittedTransaction[]
  /** Fresh provider and active-quote state read after the check or mutation completed. */
  stateAfterCheck: LadderVerboseState
  /** Per-side clamp, clearance, and funding counts from generation, when a quote was derived. */
  diagnostics?: LadderDiagnostics
  /** Rungs per side the opposing book repriced, when this check prepared a publication. */
  bookClearedRungs?: { lower: number; higher: number }
  /** Monotonic per-group consumption observed for this market, when the adapter reports it. */
  groupConsumption?: readonly LadderGroupConsumption[]
  /** Wall-clock duration of this market's check, including the post-check verbose re-read. */
  durationMs?: number
}
