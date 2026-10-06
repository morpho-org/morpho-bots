import type { Hex } from 'viem'

import type { LossFactorObservation } from '../../domain/loss-factor'
import type {
  BootstrapDecisionDiagnostics,
  BootstrapOffer,
  BootstrapPosition,
  BootstrapRate,
  PositionBootstrapDecision,
  ValidBootstrapConfig
} from '../../domain/position-bootstrap'
import type { PublicationWithheld } from '../../infrastructure/exposure/exposure-admission.utils'

/** Bootstrap transaction identity shared by immediate submission and confirmed-result records. */
export type BootstrapSubmittedTransaction = {
  /** Protocol mutation represented by the transaction. */
  operation: 'cancel' | 'ratify' | 'publish'
  /** Canonical transaction hash returned by the wallet client. */
  txHash: Hex
}

/** Immediate safe event emitted after a bootstrap transaction enters the provider submission path. */
export type BootstrapTransactionSubmittedEvent = BootstrapSubmittedTransaction & {
  /** Stable JSON Lines event discriminator. */
  event: 'bootstrap.transaction-submitted'
  /** Market-local reconciliation scope; omitted for strategy-wide halt and cleanup cancellations. */
  marketId?: Hex
}

/** Optional observer notified immediately after the wallet returns a transaction hash. */
export type BootstrapTransactionSubmittedObserver = (
  transaction: BootstrapSubmittedTransaction
) => void | Promise<void>

/** Result returned by a live or read-only bootstrap make adapter. */
export type BootstrapMakeResult =
  | void
  | 'logged'
  | 'unchanged'
  | {
      /** Confirmed transactions submitted by this mutation request, in submission order. */
      submittedTransactions: readonly BootstrapSubmittedTransaction[]
      /** Why a prepared publication was released unpublished after the cancellations confirmed. */
      publicationWithheld?: PublicationWithheld
    }

/** Complete position projection shown for a verbose bootstrap check. */
export type BootstrapVerbosePosition = BootstrapPosition & {
  /** Current onchain bootstrap debt for the market. */
  debt: bigint
  /** Snapshot-block market loss factor beside the accepted value. */
  lossFactor: LossFactorObservation
  /** Representative active strategy-owned offer, when one exists. */
  activeOffer?: BootstrapOffer
  /** Whether multiple or otherwise inconsistent active groups require reconciliation. */
  requiresReconciliation: boolean
  /** Whether this process previously observed the configured initial credit target. */
  initialTargetCompleted: boolean
}

/** Availability and contents of a verbose bootstrap position read. */
export type BootstrapVerboseState =
  | {
      /** Indicates that a fresh position snapshot was read successfully. */
      status: 'observed'
      /** Sanitized credit, balance, exposure, debt, and active-offer state. */
      position: BootstrapVerbosePosition
    }
  | {
      /** Indicates that the provider could not return a usable snapshot. */
      status: 'failed'
      /** Sanitized error classification without provider payloads or credentials. */
      errorName: string
    }

/** Opt-in diagnostic context attached to one bootstrap market result. */
export type BootstrapVerboseDetails = {
  /** Complete validated market strategy configuration. */
  config: ValidBootstrapConfig
  /** Fresh provider state observed before the decision. */
  currentState: BootstrapVerboseState
  /** State used by the decision after accounting for earlier plans in the same cycle. */
  effectiveState?: BootstrapVerbosePosition
  /** Reference-rate observation used for rate derivation, when required. */
  referenceRate?: BootstrapRate
  /** Resolved time-to-maturity premium included in `targetRateBps`, when configured. */
  maturityPremiumBps?: bigint
  /** Premium-adjusted target rate used to build or compare the bootstrap offer. */
  targetRateBps?: bigint
  /** Deterministic decision derived from the effective state and reference rate. */
  decision?: PositionBootstrapDecision
  /** Exact desired bootstrap offer, when the decision derives one. */
  bootstrapOffer?: BootstrapOffer
  /** Confirmed transactions submitted for this market check, in submission order. */
  submittedTransactions?: readonly BootstrapSubmittedTransaction[]
  /** Fresh provider state read after the check or mutation completed. */
  stateAfterCheck: BootstrapVerboseState
  /** Rate-range and size-cap observations from derivation, when a rate-derived decision was made. */
  diagnostics?: BootstrapDecisionDiagnostics
  /** Wall-clock duration of this market's check, including the post-check verbose re-read. */
  durationMs?: number
}
