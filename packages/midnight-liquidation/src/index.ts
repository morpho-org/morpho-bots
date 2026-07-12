import type { OpExport } from '@repo/bot-kit'

import type { MidnightActCache } from './act/act'
import type { MidnightSenseCache } from './sense/sense'

import { actOnce } from './act/act'
import { loadActConfig, loadSenseConfig } from './config'
import { senseOnce } from './sense/sense'

export type { Env, SenseConfig, ActConfig } from './config'
export { loadSenseConfig, loadActConfig } from './config'
export { DOMAIN, formatOpportunityId } from './wire'
export { runSense } from './sense/sense'
export type { MidnightSenseCache, SenseCounters } from './sense/sense'
export { runAct } from './act/act'
export type { MidnightActCache, ActCounters } from './act/act'

// Bumped when a stage's disposable cache shape changes; a mismatched cache is rebuilt, not migrated.
// The CLI keys the cache file on the op NAME, so a rename already orphans old files — these version
// only the content shape within a given op's file.
const SENSE_CACHE_VERSION = 1
const ACT_CACHE_VERSION = 1

/**
 * The flat op table this core exposes to the CLI (see `@repo/bot-kit`'s {@link OpExport}). Each op is
 * a source XOR a transform; the CLI surfaces each as its own `midnight <op>` command.
 * `unhealthy-positions` is the sensor (today's `senseOnce`); `liquidate` is the transform that
 * consumes it. The CLI dispatches this table directly.
 */
export const OPS: Record<string, OpExport> = {
  'unhealthy-positions': {
    kind: 'sense',
    cacheVersion: SENSE_CACHE_VERSION,
    validateConfig: env => loadSenseConfig(env),
    senseOnce: (env, opts) =>
      senseOnce(env, {
        cache: opts.cache as MidnightSenseCache | null,
        runStartupChecks: opts.runStartupChecks,
        logger: opts.logger,
        emit: opts.emit
      })
  },
  liquidate: {
    kind: 'act',
    cacheVersion: ACT_CACHE_VERSION,
    validateConfig: env => loadActConfig(env),
    actOnce: (env, ids, opts) =>
      actOnce(env, ids, {
        cache: opts.cache as MidnightActCache | null,
        runStartupChecks: opts.runStartupChecks,
        logger: opts.logger,
        emit: opts.emit
      })
  }
}
