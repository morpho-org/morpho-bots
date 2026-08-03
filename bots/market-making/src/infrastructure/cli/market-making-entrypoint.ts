import type { CliRuntimeOptions } from './cli'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { PositionBootstrapMonitorHaltedError } from '../../application/bootstrap/position-bootstrap-monitor-halted.error'
import { OfferInvalidationFailedError } from '../../application/invalidation/offer-invalidation-failed.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../application/ladder/ladder-monitor-halted.error'
import { SetupFailedError } from '../../application/setup/setup-failed.error'
import { SetupMonitorHaltedError } from '../../application/setup/setup-monitor-halted.error'
import { createMarketMakingLogger } from './market-making-logger'

type MarketMakingApplication = {
  run(argv: readonly string[], runtime?: CliRuntimeOptions): Promise<unknown>
}
type EntrypointOutput = { writeOut(value: string): void; writeError(value: string): void }

const failureDetails = (error: unknown): unknown => {
  if (error instanceof SetupMonitorHaltedError) return error.report
  if (error instanceof OfferInvalidationFailedError) return error.report
  if (error instanceof PositionBootstrapMonitorHaltedError) return error.report
  if (error instanceof LadderMonitorHaltedError) return error.report
  if (error instanceof LadderCycleHaltedError) return error.report
  if (error instanceof PositionBootstrapHaltedError) return error.report
  if (error instanceof SetupFailedError) return error.report
  return undefined
}

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown failure'

/**
 * Runs one market-making CLI invocation and maps sanitized output to a process exit contract.
 * @param application - Composed CLI application.
 * @param argv - User arguments without runtime/executable prefixes.
 * @param output - Standard output and error writers.
 * @param runtime - Optional graceful-shutdown signal for continuous commands.
 * @returns Zero on success and one after a sanitized failure has been emitted.
 * @remarks Output is human-readable unless `--json` selects one JSON Lines record per value.
 * Continuous readiness, bootstrap, ladder, or invalidation transaction records precede the terminal
 * result; read-only make records may also precede workflow results. Failure reports exclude causes,
 * provider payloads, and credentials and always include an explicit error message.
 */
export const runMarketMakingEntrypoint = async (
  application: MarketMakingApplication,
  argv: readonly string[],
  output: EntrypointOutput,
  runtime: Pick<CliRuntimeOptions, 'signal'> = {}
) => {
  const json = argv.includes('--json')
  const logger = createMarketMakingLogger(output, json)
  try {
    const result = await application.run(argv, {
      ...runtime,
      writeEvent: value => logger.result(value)
    })
    logger.result(result)
    return 0
  } catch (error) {
    logger.error(failureMessage(error), failureDetails(error))
    return 1
  }
}
