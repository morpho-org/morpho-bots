import type { JournalBuildIdentity, Logger } from '@repo/kit'

import { classifyShippingConfig, createLogger } from '@repo/kit'

import { MONITORING_SCHEMA_VERSION } from '../../application/monitoring/monitoring-event'

/**
 * Builds the shipping logger with the event-contract version bound into its context.
 * @param options - Bot identity, chain, the build that runs, and the environment carrying the
 * shipping opt-in.
 * @returns A logger stamping `schemaVersion`, `revision` and `imageTag` onto every record, or `undefined` when shipping is off.
 * @remarks Returns `undefined` unless the opt-in is complete: a logger is what enables
 * `createRecordShipper`, and a stderr-only one would echo every record. A partial opt-in still
 * builds one, because that is what reports `logship.misconfigured` on stderr. Binding the version
 * as context costs nothing per record and lets a consumer pin the contract.
 */
export const createMonitoringLogger = (options: {
  bot: string
  chainId: number
  build?: JournalBuildIdentity
  env?: Record<string, string | undefined>
}): Logger | undefined => {
  const env = options.env ?? process.env
  const shipping = classifyShippingConfig(env).state
  if (shipping === 'disabled') return undefined
  const logger = createLogger('info', {
    env,
    context: {
      bot: options.bot,
      chainId: options.chainId,
      schemaVersion: MONITORING_SCHEMA_VERSION,
      ...options.build
    }
  })
  return shipping === 'enabled' ? logger : undefined
}
