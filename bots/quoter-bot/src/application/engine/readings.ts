import type { Hex } from 'viem'

import type { LadderMarketState, LadderQuoteSet } from '../../domain/ladder'
import type { LossFactorObservation } from '../../domain/loss-factor'
import type {
  BootstrapOffer,
  BootstrapPosition,
  BootstrapRate
} from '../../domain/position-bootstrap'
import type { LadderGroupConsumption } from '../ladder/ladder-verbose'
import type { OperatorAdapterOperation } from '../monitoring/operator-error-name.utils'
import type { SetupCheckReport } from '../setup/setup-check.service'

/** A read that may have failed, kept as a value so a decision can tell which read failed. */
export type Read<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errorName: string; adapterOperation?: OperatorAdapterOperation }>

/** One ladder market's readings at one block, in today's order: the guard, then the rest. */
export type LadderReading = Readonly<{
  strategy: 'ladder'
  marketId: Hex
  /** The block every reading was taken at. */
  block: number
  guard: Read<LossFactorObservation>
  /** Absent when the guard halted lending, which skips every other read. */
  active?: Read<{ quote?: LadderQuoteSet; consumption: readonly LadderGroupConsumption[] }>
  market?: Read<LadderMarketState>
}>

/** One bootstrap market's position at one block. */
export type BootstrapReading = Readonly<{
  strategy: 'bootstrap'
  marketId: Hex
  block: number
  position: Read<
    BootstrapPosition & {
      debt: bigint
      lossFactor: LossFactorObservation
      activeOffer?: BootstrapOffer
      requiresReconciliation?: boolean
    }
  >
  /** Whether this run has seen the market reach its initial target; process memory, as before. */
  initialTargetCompleted: boolean
}>

/** One strategy market's reading from one world poll, discriminated by `strategy`. */
export type MarketReading = LadderReading | BootstrapReading

/** A market's reference observation; a ladder reads it every cycle, bootstrap only when it needs it. */
export type ReferenceReading = Read<BootstrapRate>

/** One setup monitoring report, and whether it ends the run; `cycleErrorName` names a cycle that threw. */
export type SetupReading = Readonly<{
  report: SetupCheckReport
  halting: boolean
  cycleErrorName?: string
}>

/**
 * The controller key of a strategy market. Its prefix is the workflow every intent id of the key
 * starts with, which attributes the kernel's groups to a strategy.
 * @param strategy - The strategy quoting the market.
 * @param marketId - The market id; case-insensitive.
 * @returns `<strategy>:<lowercased market id>`.
 */
export const marketKey = (strategy: 'ladder' | 'bootstrap', marketId: Hex) =>
  `${strategy}:${marketId.toLowerCase()}`
