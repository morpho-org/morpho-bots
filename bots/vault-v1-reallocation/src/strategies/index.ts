import { assertNever } from '@repo/utils'

import type { Config } from '../config'
import type { Strategy } from './strategy'

import { CAP_BUFFER_PERCENT } from '../config'
import { percentToWad } from '../math'
import {
  resolveApyRange,
  resolveMinApyDeltaBips,
  resolveMinUtilizationDeltaBips
} from '../strategy-config'
import { createApyRangeStrategy } from './apy-range'
import { createEqualizeUtilizationsStrategy } from './equalize-utilizations'

export type { MarketAllocation, Strategy } from './strategy'

/**
 * Builds the configured {@link Strategy}, binding the checked-in strategy-config tables (market >
 * vault > env-default precedence) and the env-level knobs to a pure function of one vault's data.
 */
const CAP_BUFFER_WAD = percentToWad(CAP_BUFFER_PERCENT)

export const createStrategy = (config: Config): Strategy => {
  switch (config.strategy) {
    case 'apy-range':
      return createApyRangeStrategy({
        allowIdleReallocation: config.allowIdleReallocation,
        capBufferWad: CAP_BUFFER_WAD,
        apyRange: (vault, marketId) => {
          const range = resolveApyRange(config.chainId, vault, marketId)
          return { min: percentToWad(range.min), max: percentToWad(range.max) }
        },
        minApyDeltaBips: (vault, marketId) =>
          resolveMinApyDeltaBips(config.chainId, vault, marketId, config.minApyDeltaBips)
      })
    case 'equalize-utilizations':
      return createEqualizeUtilizationsStrategy({
        capBufferWad: CAP_BUFFER_WAD,
        minUtilizationDeltaBips: vault =>
          resolveMinUtilizationDeltaBips(config.chainId, vault, config.minUtilizationDeltaBips)
      })
    default:
      return assertNever(config.strategy)
  }
}
