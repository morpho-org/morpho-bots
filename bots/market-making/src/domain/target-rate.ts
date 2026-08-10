/** Operator-selected method for deriving a workflow's target reference rate. */
export type TargetRateStrategyConfig =
  | { strategy: 'variable_rate_avg' }
  | { strategy: 'hardcoded'; hardcodedRateBps: bigint }

/** Adds target-rate method selection to an existing workflow configuration. */
export type TargetRateConfigured<T> = T & { targetRate: TargetRateStrategyConfig }

/**
 * Reports whether any active workflow derives its target from Morpho Blue history.
 * @param configurations - Active bootstrap or ladder configurations to inspect.
 * @returns `true` when at least one target-rate strategy requires Blue reference data.
 */
export const requiresVariableRateReference = (
  configurations: readonly TargetRateConfigured<unknown>[]
) => configurations.some(configuration => configuration.targetRate.strategy === 'variable_rate_avg')
