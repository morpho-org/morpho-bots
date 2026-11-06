import type { Hex } from 'viem'

import type {
  LadderDiagnostics,
  LadderMarketState,
  LadderQuoteSet,
  LadderWithdrawnSide
} from '../../domain/ladder'
import type { LendHalt } from '../../domain/loss-factor'
import type { BootstrapDecisionDiagnostics } from '../../domain/position-bootstrap'
import type { LadderBookSideCrossingReport, LadderGroupConsumption } from '../ladder/ladder-verbose'
import type { OperatorAdapterOperation } from '../monitoring/operator-error-name.utils'
import type { Outcome } from './decision'

/**
 * A decision is only ever `observed`, `failed`, or `halted`; `applied` (or `logged`, in a dry run)
 * is reserved for an act the kernel settled.
 */
export type ReportStatus = 'observed' | 'applied' | 'logged' | 'failed' | 'halted'

/** What a market reports about itself, classified, as an act carries it until it settles. */
export type Classification = Readonly<
  {
    status: ReportStatus
    action?: string
    reason?: string
    stage?: string
    errorName?: string
    adapterOperation?: OperatorAdapterOperation
    invalidated?: boolean
    strategyInvalidated?: boolean
    withdrawnSides?: readonly LadderWithdrawnSide[]
    /** The act's condition, which a dry run reports since it signs nothing. */
    condition?: string
    /** Router minimum offer size in raw loan assets, for a `below-minimum-offer` withholding. */
    minimumAssets?: string
  } & Partial<LendHalt>
>

type RateBounds = Readonly<{ minimumRateBps: bigint; maximumRateBps: bigint }>

/** What a ladder market observed and derived, for its monitoring records. */
export type LadderFacts = Readonly<{
  bounds: RateBounds
  referenceRateBps?: bigint
  targetRateBps?: bigint
  market?: LadderMarketState
  activeQuote?: LadderQuoteSet
  groupConsumption?: readonly LadderGroupConsumption[]
  diagnostics?: LadderDiagnostics
  bookCrossing?: Readonly<Record<'lower' | 'higher', LadderBookSideCrossingReport>>
}>

/** What a bootstrap market observed and derived, for its monitoring records. */
export type BootstrapFacts = Readonly<{
  bounds: RateBounds
  creditTargetAssets: bigint
  creditAssets?: bigint
  referenceRateBps?: bigint
  targetRateBps?: bigint
  diagnostics?: BootstrapDecisionDiagnostics
}>

/** The operation of one transaction an act included. */
export type SettledTransaction = Readonly<{
  operation: 'cancel' | 'ratify' | 'publish'
  txHash: Hex
}>

/** One market's report: from its decision, or from the outcome of its act. */
export type MarketReport = Classification &
  Readonly<{ marketId: Hex; transactions?: readonly SettledTransaction[] }> &
  (
    | Readonly<{ workflow: 'ladder'; facts?: LadderFacts }>
    | Readonly<{ workflow: 'bootstrap'; facts?: BootstrapFacts }>
  )

/** The strategy a market report belongs to: `ladder` or `bootstrap`. */
export type Workflow = MarketReport['workflow']

/**
 * The report of a decision that sends an act: the act is only queued until it settles, unless the
 * decision already failed, which stays a failure.
 * @param detail - The decision's own classification.
 * @param acts - Whether the decision sends an act.
 * @returns `queued` for a sending decision that did not fail, else `detail` unchanged.
 */
export const decisionClassification = (detail: Classification, acts: boolean): Classification =>
  acts && detail.status !== 'failed' ? { ...detail, status: 'observed', action: 'queued' } : detail

/**
 * A market whose readings are unavailable, as a failed world read or a fail-closed withdrawal.
 * @param workflow - The market's strategy, which picks the failed stage.
 * @param marketId - The market whose readings failed.
 * @param errorName - Operator-safe error name; never a message or response body.
 * @returns A failed, invalidated report.
 */
export const unavailableReport = (
  workflow: Workflow,
  marketId: Hex,
  errorName: string
): MarketReport => ({
  workflow,
  marketId,
  status: 'failed',
  stage: workflow === 'ladder' ? 'market-read' : 'position-read',
  invalidated: true,
  errorName
})

/**
 * The operation of each transaction an act included, from its planned step: a replacement's plan is
 * its cancellation, if any, then the publication's ratification and publication, as `quoterPlans`
 * builds it.
 */
const settledTransactions = (outcome: Outcome): readonly SettledTransaction[] => {
  const cancels = ((outcome.payload as { cancel?: readonly string[] }).cancel?.length ?? 0) > 0
  const publication = cancels ? 1 : 0
  return outcome.transactions.map(transaction => ({
    operation:
      outcome.kind !== 'replace' || transaction.step < publication
        ? 'cancel'
        : transaction.step === publication
          ? 'ratify'
          : 'publish',
    txHash: transaction.hash as Hex
  }))
}

/**
 * The report of an ended act. A settled act reports what its payload carried, as applied (logged
 * in a dry run) unless it withdrew a failed market, and one that did not settle failed at `act`.
 * @param outcome - The ended act's outcome from the kernel.
 * @param market - The act's workflow, market, and whether the run is dry.
 * @param current - The market's current decision report, whose facts describe it after the act.
 * @returns The market report for the ended act.
 */
export const outcomeReport = (
  outcome: Outcome,
  market: Readonly<{ workflow: Workflow; marketId: Hex; dry: boolean }>,
  current: MarketReport | undefined
): MarketReport => {
  const transactions = settledTransactions(outcome)
  const base = {
    workflow: market.workflow,
    marketId: market.marketId,
    ...(current?.facts ? { facts: current.facts } : {}),
    ...(transactions.length > 0 ? { transactions } : {})
  } as Pick<MarketReport, 'workflow' | 'marketId' | 'facts' | 'transactions'>
  if (outcome.notice !== 'settled')
    return {
      ...base,
      status: 'failed',
      stage: 'act',
      invalidated: false,
      errorName: 'KernelPlanError',
      reason: outcome.notice
    } as MarketReport
  const carried = (outcome.payload as unknown as { report: Classification }).report
  const status = carried.status === 'failed' ? 'failed' : market.dry ? 'logged' : 'applied'
  return { ...carried, ...base, status } as MarketReport
}
