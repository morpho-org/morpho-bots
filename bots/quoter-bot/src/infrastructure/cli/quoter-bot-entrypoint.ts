import { createCliLogger } from '@repo/logging'

import type { CliRuntimeOptions } from './cli'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { PositionBootstrapMonitorHaltedError } from '../../application/bootstrap/position-bootstrap-monitor-halted.error'
import { OfferInvalidationFailedError } from '../../application/invalidation/offer-invalidation-failed.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../application/ladder/ladder-monitor-halted.error'
import { isShippableRecord } from '../../application/monitoring/monitoring-event'
import { terminalMonitoringEvents } from '../../application/monitoring/terminal-monitoring.utils'
import { operatorErrorName } from '../../application/operator-error-name.utils'
import { QuoterBotMonitorHaltedError } from '../../application/quoter-bot/quoter-bot-monitor-halted.error'
import { SafeProviderError } from '../../application/setup/safe-provider.error'
import { SetupFailedError } from '../../application/setup/setup-failed.error'
import { SetupMonitorHaltedError } from '../../application/setup/setup-monitor-halted.error'
import { ConfigFileError } from '../../config/config-file.error'
import { ConfigValidationError } from '../../config/config-validation.error'
import { BootstrapConfigurationError } from '../../domain/bootstrap/bootstrap-configuration.error'
import { LadderConfigurationError } from '../../domain/ladder/ladder-configuration.error'
import { MakerAccountError } from '../make/maker-account.error'
import { CliUsageError } from './cli-usage.error'

type QuoterBotApplication = {
  run(argv: readonly string[], runtime?: CliRuntimeOptions): Promise<unknown>
}
type EntrypointOutput = { writeOut(value: string): void; writeError(value: string): void }
type EntrypointObservability = {
  record(value: unknown): void
  unexpected(error: unknown, origin: 'entrypoint'): void
}

/** CLI commands whose safe verbose event stream may be auto-enabled by observability shipping. */
export const QUOTER_BOT_VERBOSE_COMMANDS = ['start', 'bootstrap', 'ladder'] as const

const REPORTED_ERRORS = [
  QuoterBotMonitorHaltedError,
  SetupMonitorHaltedError,
  OfferInvalidationFailedError,
  PositionBootstrapMonitorHaltedError,
  LadderMonitorHaltedError,
  LadderCycleHaltedError,
  PositionBootstrapHaltedError,
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
    error instanceof MakerAccountError ||
    error instanceof SafeProviderError ||
    error instanceof BootstrapConfigurationError ||
    error instanceof LadderConfigurationError
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
      }
    })
    logger.result(result)
    return 0
  } catch (error) {
    if (runtime.signal?.aborted === true && error instanceof Error && error.name === 'AbortError') {
      return 0
    }
    const details = failureDetails(error)
    if (details === undefined && !(error instanceof MakerAccountError)) {
      observability?.unexpected(error, 'entrypoint')
    } else if (details !== undefined) {
      for (const event of terminalMonitoringEvents(details, operatorErrorName(error))) {
        observability?.record(event)
      }
    }
    logger.error(failureMessage(error), details)
    return 1
  }
}
