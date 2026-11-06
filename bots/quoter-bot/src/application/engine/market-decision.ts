import type { ValidLadderConfig } from '../../domain/ladder'
import type { ValidBootstrapConfig } from '../../domain/position-bootstrap'
import type { BootstrapPrepareAnswer } from './bootstrap-decision'
import type { Decision, LiveView, Observed, Prepared } from './decision'
import type { LadderCrossings, LadderPrepareAnswer } from './ladder-decision'
import type { MarketReport } from './market-report'
import type { MarketReading, ReferenceReading } from './readings'
import type { WorldAccounting, WorldReading } from './world'

import { BootstrapAdapterError, LadderAdapterError } from '../../errors'
import { bootstrapPrepareRequest, decideBootstrap } from './bootstrap-decision'
import { bootstrapReading } from './bootstrap-state'
import { exposureSnapshot } from './exposure'
import { decideLadder, ladderPrepareRequest } from './ladder-decision'
import { ladderReading } from './ladder-state'
import { derive } from './world'

/** The answer a market's preparation returns, for either strategy. */
export type PrepareAnswer = LadderPrepareAnswer | BootstrapPrepareAnswer

/** What a market's decision reads besides its world reading, from this run's own history. */
type MarketContext = Readonly<{
  reference: Observed<ReferenceReading>
  view: LiveView
  crossings: LadderCrossings
  /** Whether an earlier poll of this run saw the bootstrap market reach its initial target. */
  completed: boolean
}>

/**
 * One market's reading from one world poll, as both strategies derive it at the world's block.
 * @param world - One world poll's reading, which names the strategy.
 * @param config - The market's validated config for that strategy.
 * @param accounting - The maker, accounted markets, accepted loss factors, and V0 group ids.
 * @param completed - Whether an earlier poll saw a bootstrap market reach its initial target.
 * @returns The strategy's market reading; a failed exposure read is carried, not thrown.
 */
export const marketReading = (
  world: WorldReading,
  config: ValidLadderConfig | ValidBootstrapConfig,
  accounting: WorldAccounting,
  completed: boolean
): MarketReading => {
  const exposure = derive(() =>
    exposureSnapshot(
      world,
      accounting,
      world.strategy === 'ladder' ? LadderAdapterError : BootstrapAdapterError
    )
  )
  const input = { world, exposure, accounting }
  return world.strategy === 'ladder'
    ? ladderReading({ ...input, config: config as ValidLadderConfig })
    : bootstrapReading({
        ...input,
        config: config as ValidBootstrapConfig,
        initialTargetCompleted: completed
      })
}

/** The seconds to maturity at the reading's block, which a configured maturity premium prices. */
const withMaturity = (
  reference: Observed<ReferenceReading>,
  reading: MarketReading,
  config: ValidLadderConfig | ValidBootstrapConfig
): Observed<ReferenceReading> => {
  if (config.maturityPremium === undefined) return reference
  if (reference.status !== 'ready' || !reference.value.ok) return reference
  const observed =
    reading.strategy === 'ladder'
      ? reading.market?.ok
        ? reading.market.value
        : undefined
      : reading.position.ok
        ? reading.position.value
        : undefined
  if (observed?.maturityTimestamp === undefined || observed.observedTimestamp === undefined)
    return reference
  const secondsToMaturity =
    observed.maturityTimestamp > observed.observedTimestamp
      ? observed.maturityTimestamp - observed.observedTimestamp
      : 0n
  return {
    status: 'ready',
    value: { ok: true, value: { ...reference.value.value, secondsToMaturity } }
  }
}

/**
 * What the market's preparation would be asked for now, or nothing while it would not act.
 * @param reading - The market's reading from this poll.
 * @param config - The market's validated config.
 * @param context - The reference, live view, crossings, and completion this run observed.
 * @returns The strategy-tagged request, or `undefined` when the market would not act.
 */
export const prepareRequest = (
  reading: MarketReading,
  config: ValidLadderConfig | ValidBootstrapConfig,
  context: MarketContext
) => {
  const reference = withMaturity(context.reference, reading, config)
  const request =
    reading.strategy === 'ladder'
      ? ladderPrepareRequest({
          config: config as ValidLadderConfig,
          reading,
          reference,
          view: context.view,
          crossings: context.crossings
        })
      : bootstrapPrepareRequest({ config: config as ValidBootstrapConfig, reading, reference })
  return request && { strategy: reading.strategy, ...request }
}

/**
 * A market's decision from its reading, its context, and its preparation's answer.
 * @param reading - The market's reading from this poll.
 * @param config - The market's validated config.
 * @param context - The reference, live view, crossings, and completion this run observed.
 * @param prepare - The preparation's answer for this market.
 * @returns The decision with its act, if any, and the market report detail.
 */
export const decideMarket = (
  reading: MarketReading,
  config: ValidLadderConfig | ValidBootstrapConfig,
  context: MarketContext,
  prepare: Prepared<PrepareAnswer>
): Decision & Readonly<{ detail: MarketReport }> => {
  const reference = withMaturity(context.reference, reading, config)
  return reading.strategy === 'ladder'
    ? decideLadder({
        config: config as ValidLadderConfig,
        reading,
        reference,
        view: context.view,
        crossings: context.crossings,
        prepare: prepare as Prepared<LadderPrepareAnswer>
      })
    : decideBootstrap({
        config: config as ValidBootstrapConfig,
        reading,
        reference,
        view: context.view,
        prepare: prepare as Prepared<BootstrapPrepareAnswer>
      })
}
