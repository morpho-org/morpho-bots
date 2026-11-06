import { SignerAccountError } from '@repo/kit'

import type { MonitoringEvent } from '../../application/monitoring/monitoring-event'
import type { CliRuntimeOptions } from './cli'

import { isShippableRecord } from '../../application/monitoring/monitoring-event'
import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'
import { terminalMonitoringEvents } from '../../application/monitoring/terminal-monitoring.utils'
import {
  OfferInvalidationFailedError,
  QuoterRunFailedError,
  StartupCleanupFailedError,
  SafeProviderError,
  SetupFailedError,
  ConfigFileError,
  ConfigValidationError,
  BootstrapConfigurationError,
  LadderConfigurationError,
  StrategyStateVersionError,
  QuoterTransactionError,
  CliUsageError
} from '../../errors'
import { createCliLogger } from './cli-logger.utils'

type QuoterBotApplication = {
  run(argv: readonly string[], runtime?: CliRuntimeOptions): Promise<unknown>
}
type EntrypointOutput = { writeOut(value: string): void; writeError(value: string): void }
type EntrypointObservability = {
  record(value: unknown): void
  unexpected(error: unknown, origin: 'entrypoint'): void
}

const REPORTED_ERRORS = [
  QuoterRunFailedError,
  StartupCleanupFailedError,
  OfferInvalidationFailedError,
  SetupFailedError
] as const

const failureDetails = (error: unknown) => {
  for (const reported of REPORTED_ERRORS) {
    if (error instanceof reported) return error.report
  }
  return undefined
}

const failureMessage = (error: unknown) => {
  if (
    error instanceof CliUsageError ||
    error instanceof ConfigFileError ||
    error instanceof ConfigValidationError ||
    error instanceof SignerAccountError ||
    error instanceof QuoterTransactionError ||
    error instanceof SafeProviderError ||
    error instanceof BootstrapConfigurationError ||
    error instanceof LadderConfigurationError ||
    error instanceof StrategyStateVersionError
  ) {
    return error.message
  }
  if (error instanceof Error && failureDetails(error) !== undefined) return error.message
  return operatorErrorName(error)
}

/**
 * Runs one quoter-bot CLI invocation and maps sanitized output to a process exit contract.
 * @param application - Composed CLI application.
 * @param argv - User arguments without runtime/executable prefixes.
 * @param output - Standard output and error writers.
 * @param runtime - Optional graceful-shutdown signal for continuous commands.
 * @param observability - Optional mirror for sanitized records and unexpected error classifications.
 * @returns Zero on success and one after a sanitized failure has been emitted.
 * @remarks Output is human-readable unless `--json` selects one JSON Lines record per value.
 * Failure reports exclude causes, provider payloads, and credentials and always include an
 * explicit error message.
 */
export const runQuoterBotEntrypoint = async (
  application: QuoterBotApplication,
  argv: readonly string[],
  output: EntrypointOutput,
  runtime: Pick<CliRuntimeOptions, 'signal'> = {},
  observability?: EntrypointObservability
) => {
  const optionDelimiter = argv.indexOf('--')
  const json = argv
    .slice(0, optionDelimiter === -1 ? undefined : optionDelimiter)
    .includes('--json')
  const logger = createCliLogger(output, { json, errorEvent: 'quoter-bot.error' })
  try {
    const result = await application.run(argv, {
      ...runtime,
      writeEvent: value => {
        if (isShippableRecord(value)) observability?.record(value)
        logger.result(value)
      },
      // A one-shot setup check's records reach the sinks without joining its stdout report.
      observeRecord: value => {
        if (isShippableRecord(value)) observability?.record(value)
      }
    })
    logger.result(result)
    return 0
  } catch (error) {
    if (runtime.signal?.aborted === true && error instanceof Error && error.name === 'AbortError') {
      return 0
    }
    const details = failureDetails(error)
    if (details !== undefined) {
      for (const event of terminalMonitoringEvents(details, operatorErrorName(error))) {
        observability?.record(event)
      }
    } else if (error instanceof SignerAccountError || error instanceof QuoterTransactionError) {
      const event = {
        event: 'bot.failed',
        reason: error instanceof SignerAccountError ? 'signer-account' : 'signer-transaction',
        errorName: operatorErrorName(error)
      } satisfies MonitoringEvent
      observability?.record(event)
    } else {
      observability?.unexpected(error, 'entrypoint')
    }
    logger.error(failureMessage(error), details)
    return 1
  }
}
