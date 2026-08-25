import type { Address, Hex } from 'viem'

/**
 * Version of the shipped event contract, bound once into logger context rather than onto each record.
 * @remarks Bump on any breaking field rename or removal so a consumer can pin. Adding an optional
 * field is not breaking.
 */
export const MONITORING_SCHEMA_VERSION = 1

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
 *   `loanAsset`, and every `*Bps` field is an integer basis-point value. Both serialize as decimal
 *   strings because the bot-kit logger flattens `bigint` before shipping. The bot never reads token
 *   decimals, so no field is human-scaled.
 * - **Cardinality.** Only `workflow`, `marketId`, `side`, `status`, `stage`, `action`, `reason`,
 *   `check`, `bound`, `cap`, `operation`, `state`, and `referenceMode` may be used as
 *   grouping dimensions. `txHash` and `groupId` are unbounded trace-only correlation fields and must
 *   never be grouped on. Error text never appears — only allowlisted `errorName` classifications.
 */
export type MonitoringEvent =
  | {
      event: 'bot.configured'
      bootstrapIntervalSeconds: number
      loanAsset: Address
      referenceMode: 'static' | 'variable' | 'mixed'
      readOnly: boolean
    }
  | { event: 'market.configured'; marketId: Hex; ladderIntervalSeconds?: number }
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
    }
  | {
      event: 'guardrail.rate-clamped'
      workflow: MonitoringWorkflow
      marketId: Hex
      side?: MonitoringSide
      clampedRungs: number
      bound: 'minimum' | 'maximum'
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
      event: 'guardrail.halted'
      workflow: MonitoringWorkflow
      marketId?: Hex
      stage: string
      reason: string
      strategyInvalidated: boolean
    }
  | {
      event: 'reference.observed'
      workflow: MonitoringWorkflow
      marketId: Hex
      referenceRateBps: bigint
      targetRateBps?: bigint
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
      totalAssets: bigint
      bestRateBps?: bigint
      worstRateBps?: bigint
      centerRateBps?: bigint
    }
  | {
      event: 'offer.consumed'
      marketId: Hex
      side: MonitoringSide
      consumedDeltaAssets: bigint
      groupRateBps: bigint
      remainingAssets: bigint
      groupId: Hex
    }
  | {
      event: 'transaction.settled'
      workflow: MonitoringWorkflow
      marketId?: Hex
      operation: 'cancel' | 'ratify' | 'publish'
      txHash: Hex
    }
  | { event: 'setup.check-failed'; check: string }

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
  'guardrail.rate-clamped',
  'guardrail.cross-book-cleared',
  'guardrail.exposure-capped',
  'guardrail.rungs-truncated',
  'guardrail.spread-rejected',
  'guardrail.halted',
  'reference.observed',
  'position.observed',
  'bootstrap.progress',
  'book.observed',
  'offer.consumed',
  'transaction.settled',
  'setup.check-failed'
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
