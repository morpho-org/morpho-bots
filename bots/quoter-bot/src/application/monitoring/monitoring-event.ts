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
 *   `check`, `bound`, `cap`, `operation`, `mode`, `state`, and `referenceMode` may be used as
 *   grouping dimensions. `txHash` and `groupId` are unbounded trace-only correlation fields and must
 *   never be grouped on. Error text never appears — only allowlisted `errorName` classifications.
 */
export type MonitoringEvent =
  | {
      event: 'bot.configured'
      marketIds: readonly Hex[]
      ladderIntervalSeconds: number
      bootstrapIntervalSeconds: number
      loanAsset: Address
      referenceMode: 'static' | 'variable' | 'mixed'
      readOnly: boolean
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
      clearanceBps: bigint
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
  | { event: 'guardrail.spread-rejected'; marketId: Hex; errorName: string }
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
      shortfallAssets: bigint
      mode: 'static' | 'variable'
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
      centerRateBps: bigint
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
      status: 'confirmed'
      txHash: Hex
    }
  | { event: 'setup.ready'; ready: boolean }
  | { event: 'setup.check-failed'; check: string; errorName?: string }
