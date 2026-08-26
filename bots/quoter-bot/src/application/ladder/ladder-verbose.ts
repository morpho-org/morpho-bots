import type { Hex } from 'viem'

import type { LadderConfig, LadderMarketState, LadderQuoteSet } from '../../domain/ladder/ladder'

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

/** Result returned by a live or read-only ladder make adapter. */
export type LadderMakeResult =
  | void
  | 'logged'
  | {
      /** Confirmed transactions submitted by this mutation request, in submission order. */
      submittedTransactions: readonly LadderSubmittedTransaction[]
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
  decision?: 'publish' | 'recenter' | 'resize' | 'rest'
  /** Confirmed transactions submitted for this market check, in submission order. */
  submittedTransactions?: readonly LadderSubmittedTransaction[]
  /** Fresh provider and active-quote state read after the check or mutation completed. */
  stateAfterCheck: LadderVerboseState
}
