import type { Hex } from 'viem'

/**
 * Selects every allowlisted market whose accrued credit contributes to aggregate exposure.
 * @param config - Validated allowlist and narrower bootstrap configuration.
 * @returns The complete allowlisted market sequence, including non-bootstrap markets.
 * @remarks Bootstrap-entry membership must never narrow strategy-wide exposure accounting.
 */
export const bootstrapExposureMarketIds = (config: {
  setup: { marketIds: readonly Hex[] }
  bootstrap: readonly { marketId: Hex }[]
}) => {
  void config.bootstrap
  return config.setup.marketIds
}
