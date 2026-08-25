import type { Address, Hex } from 'viem'

import type { TargetRateStrategyConfig } from '../../domain/target-rate'
import type { MonitoringEvent } from './monitoring-event'

type ConfiguredMarkets = {
  loanAsset: Address
  readOnly: boolean
  bootstrap: readonly { targetRate: TargetRateStrategyConfig }[]
  ladder: readonly {
    marketId: Hex
    loopIntervalSeconds: number
    targetRate: TargetRateStrategyConfig
  }[]
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
 * @returns One process-wide `bot.configured` record followed by one `market.configured` record per
 * configured ladder market.
 * @remarks Every absence alert is scoped by these records: without them a consumer cannot know which
 * markets should be reporting, or how long silence must last before it is a fault. Cadence is
 * per-market rather than one process-wide minimum, because a single shortest interval would make
 * every slower market look overdue. Emitted once per process start, so a redeploy re-establishes the
 * scope. Carries no credentials — the loan asset is a public address and the market IDs are the
 * configured allowlist.
 */
export const botConfiguredEvents = (configured: ConfiguredMarkets): readonly MonitoringEvent[] => [
  {
    event: 'bot.configured',
    bootstrapIntervalSeconds: configured.bootstrapIntervalSeconds,
    loanAsset: configured.loanAsset,
    referenceMode: referenceMode([...configured.bootstrap, ...configured.ladder]),
    readOnly: configured.readOnly
  },
  ...configured.ladder.map(
    (market): MonitoringEvent => ({
      event: 'market.configured',
      marketId: market.marketId,
      ladderIntervalSeconds: market.loopIntervalSeconds
    })
  )
]
