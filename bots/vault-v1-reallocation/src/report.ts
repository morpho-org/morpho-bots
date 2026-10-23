import type { KernelView } from '@repo/controller'
import type { Keyed } from '@repo/engine'
import type { Logger, SignedFees } from '@repo/kit'

import { isBusy } from '@repo/controller'
import { createTxReporter } from '@repo/kit'

import type { Decision, VaultReading } from './reallocation'
import type { Tick } from './stats'

/** What one read left the graph holding, read once the read has propagated. */
type ReadState = Readonly<{
  vaults?: Keyed<VaultReading>
  decisions?: Keyed<Decision>
  view?: KernelView
  tick: Tick
}>

/**
 * The bot's operator log. Per read, the per-vault lines and `tick.end` (a vault the read itself failed is logged by the read); per kernel transaction, the
 * {@link createTxReporter} events and `reallocation.not_broadcast`.
 */
export const createReporter = (deps: {
  whitelist: readonly string[]
  /** The fees a transaction bids, when the kernel that signed it still remembers them. */
  feesOf?: (hash: string) => SignedFees | undefined
  logger: Logger
}) => {
  const { logger } = deps

  const reportRead = ({ vaults, decisions, view, tick }: ReadState) => {
    const { write } = tick
    const failed =
      write.coverage === 'failed' || write.coverage === 'unknown'
        ? (write.reason ?? 'the read failed')
        : undefined
    const unread = new Set(write.coverage === 'carried' ? write.failed : [])
    const counts = { skipped_inflight: 0, missing_role: 0, reallocations_found: 0, errors: 0 }
    for (const vault of deps.whitelist) {
      const reading = vaults?.keys[vault]
      if (failed !== undefined || reading?.status !== 'present') {
        counts.errors += 1
        if (!unread.has(vault))
          logger.error('vault.error', {
            vault,
            reason: failed ?? 'lens returned no row for this vault'
          })
        continue
      }
      if (isBusy(view, vault)) {
        counts.skipped_inflight += 1
        logger.debug('vault.inflight', { vault })
        continue
      }
      const decision = decisions?.keys[vault]
      if (decision?.status !== 'present') continue
      if (decision.value.reason === 'missing_role') {
        counts.missing_role += 1
        logger.warn('allocator.missing_role', { vault })
        continue
      }
      const { nonAdaptiveCurveMarketIds } = reading.value
      if (nonAdaptiveCurveMarketIds.length > 0)
        logger.debug('market.non_adaptive_curve', { vault, markets: nonAdaptiveCurveMarketIds })
      if (decision.value.allocations) counts.reallocations_found += 1
    }
    logger.info('tick.end', {
      blockNumber: tick.block,
      vaults: deps.whitelist.length,
      ...tick.counts,
      ...counts,
      errors: counts.errors + tick.counts.errors
    })
  }

  const reportActivity = createTxReporter({
    logger,
    feesOf: deps.feesOf,
    reportNotSent: ({ id, ...fields }) =>
      logger.info('reallocation.not_broadcast', { vault: id, ...fields })
  })

  return { reportRead, reportActivity }
}
