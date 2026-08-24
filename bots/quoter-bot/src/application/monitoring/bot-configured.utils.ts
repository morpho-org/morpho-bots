import type { Address, Hex } from 'viem'

import type { TargetRateStrategyConfig } from '../../domain/target-rate'
import type { MonitoringEvent } from './monitoring-event'

type ConfiguredMarkets = {
  marketIds: readonly Hex[]
  loanAsset: Address
  readOnly: boolean
  bootstrap: readonly { targetRate: TargetRateStrategyConfig }[]
  ladder: readonly { loopIntervalSeconds: number; targetRate: TargetRateStrategyConfig }[]
  bootstrapIntervalSeconds: number
}

const referenceMode = (
  configurations: readonly { targetRate: TargetRateStrategyConfig }[]
): 'static' | 'variable' | 'mixed' => {
  const variable = configurations.some(item => item.targetRate.strategy === 'variable_rate_avg')
  const staticRate = configurations.some(item => item.targetRate.strategy === 'hardcoded')
  if (variable && staticRate) return 'mixed'
  return variable ? 'variable' : 'static'
}

/**
 * Projects the startup manifest describing what this process is configured to quote.
 * @param configured - Validated market allowlist, loan asset, mode, cadences, and rate strategies.
 * @returns One `bot.configured` record.
 * @remarks Every absence alert is scoped by this record: without it a consumer cannot know which
 * markets should be reporting, or how long silence must last before it is a fault. Emitted once per
 * process start, so a redeploy re-establishes the scope. Carries no credentials — the loan asset is
 * a public address and the market IDs are the configured allowlist.
 */
export const botConfiguredEvent = (configured: ConfiguredMarkets): MonitoringEvent => ({
  event: 'bot.configured',
  marketIds: configured.marketIds,
  ladderIntervalSeconds: configured.ladder.reduce(
    (shortest, item) => Math.min(shortest, item.loopIntervalSeconds),
    Number.POSITIVE_INFINITY
  ),
  bootstrapIntervalSeconds: configured.bootstrapIntervalSeconds,
  loanAsset: configured.loanAsset,
  referenceMode: referenceMode([...configured.bootstrap, ...configured.ladder]),
  readOnly: configured.readOnly
})
