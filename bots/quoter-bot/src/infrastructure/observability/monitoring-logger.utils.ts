import type { Logger } from '@repo/bot-kit'

import { classifyShippingConfig, createLogger, railwayContext } from '@repo/bot-kit'

import { MONITORING_SCHEMA_VERSION } from '../../application/monitoring/monitoring-event'

/**
 * Builds the shipping logger with the event-contract version bound into its context.
 * @param options - Bot identity, chain, and the environment carrying the shipping opt-in.
 * @returns A logger stamping `schemaVersion` onto every record, or `undefined` when shipping is off.
 * @remarks Returns `undefined` unless the opt-in is complete, because supplying a logger to
 * `createBotObservability` is itself what enables shipping — building one unconditionally would
 * start emitting lifecycle records on a plain local run. Binding the version as context costs
 * nothing per record and lets a consumer pin the contract.
 */
export const createMonitoringLogger = (options: {
  bot: string
  chainId: number
  env?: Record<string, string | undefined>
}): Logger | undefined => {
  const env = options.env ?? process.env
  if (classifyShippingConfig(env).state !== 'enabled') return undefined
  return createLogger('info', {
    env,
    context: {
      bot: options.bot,
      chainId: options.chainId,
      schemaVersion: MONITORING_SCHEMA_VERSION,
      ...railwayContext(env)
    }
  })
}
