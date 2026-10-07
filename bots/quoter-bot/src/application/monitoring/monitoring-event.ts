import type { Address, Hex } from 'viem'

import type { LendHalt, LossFactorDirection } from '../../domain/loss-factor'
import type { OperatorAdapterOperation } from './operator-error-name.utils'

import { incrementalLossBps } from '../../domain/loss-factor'

/**
 * Version of the shipped event contract, bound once into logger context rather than onto each record.
 * @remarks Bump on any breaking field rename or removal so a consumer can pin. Adding an optional
 * field is not breaking.
 */
export const MONITORING_SCHEMA_VERSION = 4

/** Workflow that produced one monitoring record. */
export type MonitoringWorkflow = 'setup-check' | 'bootstrap' | 'ladder'

/** Rate side of a ladder quote: `lower` sells accrued credit, `higher` lends fresh cash. */
export type MonitoringSide = 'lower' | 'higher'

/**
 * One flat, aggregatable record shipped to the log source.
 *
 * Every variant carries a stable `event` discriminator, and every payload field is a top-level
 * scalar so Better Stack metric expressions can group on it. Two rules hold across the union and are
 * enforced by construction rather than by types:
 *
 * - **Units.** Every `*Assets` field is an unsigned raw smallest-unit amount of the configured
 *   `loanAsset`, every `*Units` field is an unsigned raw amount of Midnight credit units (face, in
 *   the same smallest unit), and every `*Bps` field is an integer basis-point value. All serialize as
 *   decimal strings because the bot-kit logger flattens `bigint` before shipping. The bot never reads
 *   token decimals, so no field is human-scaled. Capacity, reservation, and exposure-cap
 *   `*Assets` fields count face credit, as `creditAssets` does.
 * - **Cardinality.** Only `workflow`, `marketId`, `side`, `status`, `stage`, `action`, `reason`,
 *   `check`, `bound`, `cap`, `operation`, `state`, `referenceMode`, `direction`, `defaulted`, and
 *   `adapterOperation` may be used as grouping dimensions; `adapterOperation` is an allowlisted literal, never provider text.
 *   `txHash` and `groupId` are unbounded trace-only correlation fields and must never be grouped on.
 *   Error text never appears — only allowlisted `errorName` classifications.
 */
export type MonitoringEvent =
  | {
      event: 'bot.configured'
      bootstrapIntervalSeconds: number
      loanAsset: Address
      referenceMode: 'static' | 'variable' | 'mixed'
      readOnly: boolean
    }
  | {
      event: 'market.configured'
      marketId: Hex
      ladder: boolean
      bootstrap: boolean
      ladderIntervalSeconds?: number
    }
  | {
      event: 'bot.failed'
      workflow?: MonitoringWorkflow
      reason: string
      errorName?: string
    }
  | {
      event: 'cycle.completed'
      workflow: MonitoringWorkflow
      marketId?: Hex
      status: string
      stage?: string
      action?: string
      reason?: string
      durationMs?: number
      errorName?: string
      adapterOperation?: OperatorAdapterOperation
      /** Allowlisted cause of a `snapshot-unavailable` failure. */
      snapshotErrorOperation?: OperatorAdapterOperation
    }
  | {
      /**
       * Derived rates outside the hard range were omitted, never clamped onto `bound`;
       * `outermostRateBps` is the most extreme omitted rate.
       */
      event: 'guardrail.rate-omitted'
      workflow: MonitoringWorkflow
      marketId: Hex
      side?: MonitoringSide
      omittedRungs: number
      omittedAssets: bigint
      bound: 'minimum' | 'maximum'
      outermostRateBps: bigint
      referenceRateBps?: bigint
      minimumRateBps: bigint
      maximumRateBps: bigint
    }
  | {
      event: 'guardrail.cross-book-cleared'
      workflow: MonitoringWorkflow
      marketId: Hex
      side: MonitoringSide
      clearedRungs: number
    }
  | {
      /** The opposing market book, rather than an own offer, repriced rungs at publication. */
      event: 'guardrail.book-cleared'
      workflow: MonitoringWorkflow
      marketId: Hex
      side: MonitoringSide
      clearedRungs: number
    }
  | {
      /**
       * A third party currently crosses this strategy's resting ladder on `side`; `clearable` says
       * the configured rate window could still clear it, `suppressed` that the replacement cooldown
       * held.
       */
      event: 'guardrail.book-crossed'
      workflow: MonitoringWorkflow
      marketId: Hex
      side: MonitoringSide
      clearable: boolean
      suppressed: boolean
    }
  | {
      event: 'guardrail.exposure-capped'
      workflow: MonitoringWorkflow
      marketId: Hex
      requestedAssets: bigint
      cappedAssets: bigint
      cap: string
    }
  | {
      event: 'guardrail.rungs-truncated'
      marketId: Hex
      side: MonitoringSide
      configuredRungs: number
      fundedRungs: number
    }
  | { event: 'guardrail.spread-rejected'; marketId: Hex }
  | {
      /** A prepared publication was released unpublished after its replaced groups were cancelled. */
      event: 'guardrail.publication-withheld'
      workflow: MonitoringWorkflow
      marketId: Hex
      reason:
        | 'capacity-changed'
        | 'price-changed'
        | 'loss-factor-mismatch'
        | 'snapshot-unavailable'
        | 'below-minimum-offer'
        | 'rate-out-of-range'
      /** Router minimum offer size in raw loan assets, present for `below-minimum-offer`. */
      minimumAssets?: string
    }
  | {
      /**
       * A desired side left unpublished because its tick window was empty. The bootstrap buy is side
       * `higher` and reports only its snapshot here; its publication block reports
       * `guardrail.publication-withheld` with `rate-out-of-range`.
       */
      event: 'guardrail.side-withdrawn'
      workflow: 'ladder' | 'bootstrap'
      marketId: Hex
      side: MonitoringSide
    }
  | {
      /** Lending is halted by a loss-factor mismatch; cadence per {@link createLendHaltedEvents}. */
      event: 'guardrail.lend-halted'
      workflow: MonitoringWorkflow
      marketId: Hex
      lossFactor: bigint
      acceptedLossFactor: bigint
      defaulted: boolean
      direction: LossFactorDirection
      /** Lender credit slashed since the accepted value; present only for `above`. */
      incrementalLossBps?: bigint
    }
  | {
      event: 'guardrail.halted'
      workflow: MonitoringWorkflow
      marketId?: Hex
      stage: string
      reason: string
      strategyInvalidated: boolean
      adapterOperation?: OperatorAdapterOperation
    }
  | {
      event: 'reference.observed'
      workflow: MonitoringWorkflow
      marketId: Hex
      referenceRateBps: bigint
      targetRateBps?: bigint
    }
  | {
      /** Lend-rate skew a configured inventory skew applied to the decision's higher side. */
      event: 'inventory-skew.observed'
      workflow: MonitoringWorkflow
      marketId: Hex
      inventorySkewBps: bigint
      skewClamped: boolean
      creditAssets: bigint
      neutralCredit: bigint
    }
  | {
      event: 'position.observed'
      marketId: Hex
      cashBalanceAssets?: bigint
      creditAssets?: bigint
      otherMarketCreditAssets?: bigint
      reservedAssets?: bigint
      marketReservedAssets?: bigint
      maturityTimestamp?: bigint
      lowerRateCapacityAssets?: bigint
      higherRateCapacityAssets?: bigint
      targetMarketCapacityAssets?: bigint
      maximumTotalCapacityAssets?: bigint
    }
  | {
      event: 'bootstrap.progress'
      marketId: Hex
      creditAssets: bigint
      creditTargetAssets: bigint
    }
  | {
      event: 'book.observed'
      marketId: Hex
      side: MonitoringSide
      state: 'quoting' | 'empty'
      rungs: number
      totalUnits: bigint
      bestRateBps?: bigint
      worstRateBps?: bigint
      centerRateBps?: bigint
    }
  | {
      event: 'offer.consumed'
      marketId: Hex
      side: MonitoringSide
      consumedDeltaUnits: bigint
      groupRateBps: bigint
      remainingUnits: bigint
      groupId: Hex
    }
  | {
      event: 'transaction.settled'
      workflow: MonitoringWorkflow
      marketId?: Hex
      operation: 'cancel' | 'ratify' | 'publish'
      txHash: Hex
    }
  | {
      event: 'transaction.lifecycle'
      state: 'submitted' | 'broadcast-unknown' | 'replaced' | 'confirmed' | 'reverted' | 'dropped'
      nonce: number
      txHash: Hex
      previousTxHash?: Hex
      attempt?: number
      blockNumber?: bigint
      reason?: string
    }
  | { event: 'setup.check-failed'; check: string; status: 'failed' }
  | { event: 'setup.check-warning'; check: string; status: 'warning' }

/**
 * Event names that may be shipped to the log source.
 * @remarks Shipping is an explicit allowlist, not "any record carrying an `event`". Several
 * operator-facing records — the `quoter-bot.cycle` envelope and `readonly.make` — are named but
 * nested and unversioned, so they belong on stdout only. `TRANSACTION_SUBMITTED_EVENTS` are the
 * pre-receipt counterparts of `transaction.settled` and are already flat, so they ship unchanged.
 * The type assertions below fail to compile if a `MonitoringEvent` variant is added without being
 * listed here, or if a name is listed that no variant declares.
 */
const MONITORING_EVENT_NAMES = [
  'bot.configured',
  'market.configured',
  'bot.failed',
  'cycle.completed',
  'guardrail.rate-omitted',
  'guardrail.cross-book-cleared',
  'guardrail.book-cleared',
  'guardrail.book-crossed',
  'guardrail.exposure-capped',
  'guardrail.rungs-truncated',
  'guardrail.spread-rejected',
  'guardrail.publication-withheld',
  'guardrail.side-withdrawn',
  'guardrail.lend-halted',
  'guardrail.halted',
  'reference.observed',
  'inventory-skew.observed',
  'position.observed',
  'bootstrap.progress',
  'book.observed',
  'offer.consumed',
  'transaction.settled',
  'transaction.lifecycle',
  'setup.check-failed',
  'setup.check-warning'
] as const satisfies readonly MonitoringEvent['event'][]

type MissingFromAllowlist = Exclude<
  MonitoringEvent['event'],
  (typeof MONITORING_EVENT_NAMES)[number]
>
const _allowlistIsExhaustive: MissingFromAllowlist extends never ? true : never = true
void _allowlistIsExhaustive

const TRANSACTION_SUBMITTED_EVENTS = [
  'ladder.transaction-submitted',
  'bootstrap.transaction-submitted',
  'offer-invalidation.transaction-submitted'
] as const

const shippableEvents: ReadonlySet<string> = new Set([
  ...MONITORING_EVENT_NAMES,
  ...TRANSACTION_SUBMITTED_EVENTS
])

/**
 * Reports whether one written record belongs on the shipped monitoring stream.
 * @param value - Any value passed to the CLI event writer.
 * @returns `true` only for a record whose `event` is on the shipping allowlist.
 * @remarks Terminal output is unaffected; this gates shipping alone. Anything not listed stays a
 * local operator record, which keeps nested unversioned report shapes out of the log source.
 */
export const isShippableRecord = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  shippableEvents.has(String((value as { event?: unknown }).event))

/**
 * Projects a sanitized result's allowlisted adapter operation into an optional shipped field.
 * @param result - Sanitized workflow result carrying an optional allowlisted adapter operation.
 * @returns The adapter-operation field when present, otherwise an empty object.
 */
export const adapterOperationOf = (result: {
  marketId: Hex
  adapterOperation?: OperatorAdapterOperation
}) => (result.adapterOperation === undefined ? {} : { adapterOperation: result.adapterOperation })

/**
 * Projects the allowlisted cause behind a `snapshot-unavailable` failure onto a monitoring record.
 * @param result - One sanitized market outcome.
 * @returns `{ snapshotErrorOperation }` when the result carries one, otherwise an empty object.
 */
export const snapshotErrorOperationOf = (result: object) =>
  'snapshotErrorOperation' in result && result.snapshotErrorOperation !== undefined
    ? { snapshotErrorOperation: result.snapshotErrorOperation as OperatorAdapterOperation }
    : {}

/**
 * Projects a withheld publication into its guardrail record.
 * @param workflow - Strategy that prepared the publication.
 * @param result - One sanitized market outcome.
 * @returns One `guardrail.publication-withheld` record, or none for any other outcome.
 */
export const publicationWithheldEvents = (
  workflow: MonitoringWorkflow,
  result: {
    marketId: Hex
    status: string
    action?: string
    reason?: string
    adapterOperation?: string
    minimumAssets?: string
  }
): readonly MonitoringEvent[] => {
  const reason =
    result.action === 'publication-withheld'
      ? result.reason === 'loss-factor-mismatch' ||
        result.reason === 'price-changed' ||
        result.reason === 'below-minimum-offer' ||
        result.reason === 'rate-out-of-range'
        ? result.reason
        : ('capacity-changed' as const)
      : result.status === 'failed' && result.adapterOperation === 'snapshot-unavailable'
        ? ('snapshot-unavailable' as const)
        : undefined
  return reason === undefined
    ? []
    : [
        {
          event: 'guardrail.publication-withheld',
          workflow,
          marketId: result.marketId,
          reason,
          ...(reason === 'below-minimum-offer' && result.minimumAssets !== undefined
            ? { minimumAssets: result.minimumAssets }
            : {})
        }
      ]
}

/** Cycles a continuing, unchanged lend halt stays silent between repeated `guardrail.lend-halted` records. */
export const LEND_HALTED_REPEAT_CYCLES = 10

const lendHaltOf = (result: object): LendHalt | undefined =>
  'lossFactor' in result &&
  'acceptedLossFactor' in result &&
  'defaulted' in result &&
  'direction' in result
    ? (result as LendHalt)
    : undefined

/**
 * Creates the stateful `guardrail.lend-halted` projection for one process.
 * @returns A projection emitting a record when a market's halt starts or its values change, and
 * again every {@link LEND_HALTED_REPEAT_CYCLES} cycles while it continues unchanged.
 * @remarks Any result carrying a known halt counts, including one whose cancellation failed or
 * halted the strategy. A market whose result carries none ends its halt; one absent from a cycle
 * keeps it.
 */
export const createLendHaltedEvents = () => {
  const halts = new Map<string, { values: string; cycles: number }>()
  return (
    workflow: MonitoringWorkflow,
    results: readonly { marketId: Hex }[]
  ): readonly MonitoringEvent[] =>
    results.flatMap(result => {
      const key = `${workflow}:${result.marketId}`
      const halt = lendHaltOf(result)
      if (!halt) {
        halts.delete(key)
        return []
      }
      const values = `${halt.lossFactor}:${halt.acceptedLossFactor}`
      const previous = halts.get(key)
      const repeated =
        previous?.values === values && previous.cycles + 1 < LEND_HALTED_REPEAT_CYCLES
      halts.set(key, { values, cycles: repeated ? previous.cycles + 1 : 0 })
      if (repeated) return []
      const lossBps = incrementalLossBps(halt)
      return [
        {
          event: 'guardrail.lend-halted',
          workflow,
          marketId: result.marketId,
          lossFactor: halt.lossFactor,
          acceptedLossFactor: halt.acceptedLossFactor,
          defaulted: halt.defaulted,
          direction: halt.direction,
          ...(lossBps === undefined ? {} : { incrementalLossBps: lossBps })
        }
      ]
    })
}
