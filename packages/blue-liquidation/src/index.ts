import type { Operation } from '@repo/pipeline'

import type { BlueLiquidateCache } from './ops/liquidate'
import type { BlueUnhealthyPositionsCache } from './ops/unhealthy-positions'

import { loadLiquidateConfig, loadUnhealthyPositionsConfig } from './config'
import { runLiquidate } from './ops/liquidate'
import { runUnhealthyPositions } from './ops/unhealthy-positions'

export type { Env, UnhealthyPositionsConfig, LiquidateConfig } from './config'
export { loadUnhealthyPositionsConfig, loadLiquidateConfig } from './config'
export { DOMAIN, formatPositionId } from './position-id'
export { findUnhealthyPositions } from './ops/unhealthy-positions'
export type {
  BlueUnhealthyPositionsCache,
  UnhealthyPositionsCounters
} from './ops/unhealthy-positions'
export { prepareLiquidations } from './ops/liquidate'
export type { BlueLiquidateCache, LiquidateCounters } from './ops/liquidate'

// Bumped when a stage's disposable cache shape changes; a mismatched cache is rebuilt, not migrated.
// The CLI keys the cache file on the op NAME, so a rename already orphans old files — these version
// only the content shape within a given op's file.
const UNHEALTHY_POSITIONS_CACHE_VERSION = 1
const LIQUIDATE_CACHE_VERSION = 1

/**
 * The flat op table this core exposes to the CLI (see `@repo/pipeline`'s {@link Operation}). Each op is
 * a source XOR a transform; the CLI surfaces each as its own `blue <op>` command. `unhealthy-positions`
 * is the sensor; `liquidate` is the transform that consumes it. The CLI dispatches this table directly.
 */
export const OPS: Record<string, Operation> = {
  'unhealthy-positions': {
    kind: 'source',
    cacheVersion: UNHEALTHY_POSITIONS_CACHE_VERSION,
    validateConfig: env => loadUnhealthyPositionsConfig(env),
    run: (env, opts) =>
      runUnhealthyPositions(env, {
        cache: opts.cache as BlueUnhealthyPositionsCache | null,
        runStartupChecks: opts.runStartupChecks,
        logger: opts.logger,
        emit: opts.emit
      })
  },
  liquidate: {
    kind: 'transform',
    cacheVersion: LIQUIDATE_CACHE_VERSION,
    validateConfig: env => loadLiquidateConfig(env),
    run: (env, ids, opts) =>
      runLiquidate(env, ids, {
        cache: opts.cache as BlueLiquidateCache | null,
        runStartupChecks: opts.runStartupChecks,
        logger: opts.logger,
        emit: opts.emit
      })
  }
}
