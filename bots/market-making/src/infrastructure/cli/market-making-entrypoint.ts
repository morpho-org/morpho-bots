import type { CliRuntimeOptions } from './cli'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { PositionBootstrapMonitorHaltedError } from '../../application/bootstrap/position-bootstrap-monitor-halted.error'
import { OfferInvalidationFailedError } from '../../application/invalidation/offer-invalidation-failed.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../application/ladder/ladder-monitor-halted.error'
import { MarketMakingMonitorHaltedError } from '../../application/market-making/market-making-monitor-halted.error'
import { SetupFailedError } from '../../application/setup/setup-failed.error'
import { SetupMonitorHaltedError } from '../../application/setup/setup-monitor-halted.error'

type MarketMakingApplication = {
  run(argv: readonly string[], runtime?: CliRuntimeOptions): Promise<unknown>
}
type EntrypointOutput = { writeOut(value: string): void; writeError(value: string): void }

const serializeOutput = (value: unknown) =>
  typeof value === 'string'
    ? value
    : JSON.stringify(value, (_key, nested) =>
        typeof nested === 'bigint' ? nested.toString() : nested
      )

const failureOutput = (error: unknown) => {
  if (error instanceof MarketMakingMonitorHaltedError) return serializeOutput(error.report)
  if (error instanceof SetupMonitorHaltedError) return serializeOutput(error.report)
  if (error instanceof OfferInvalidationFailedError) return serializeOutput(error.report)
  if (error instanceof PositionBootstrapMonitorHaltedError) return serializeOutput(error.report)
  if (error instanceof LadderMonitorHaltedError) return serializeOutput(error.report)
  if (error instanceof LadderCycleHaltedError) return serializeOutput(error.report)
  if (error instanceof PositionBootstrapHaltedError) return serializeOutput(error.report)
  if (error instanceof SetupFailedError) return serializeOutput(error.report)
  return error instanceof Error ? error.message : 'Unknown failure'
}

/**
 * Runs one market-making CLI invocation and maps sanitized output to a process exit contract.
 * @param application - Composed CLI application.
 * @param argv - User arguments without runtime/executable prefixes.
 * @param output - Standard output and error writers.
 * @param runtime - Optional graceful-shutdown signal for continuous commands.
 * @returns Zero on success and one after a sanitized failure has been emitted.
 * @remarks Each output value is one JSON Lines record. Continuous readiness, bootstrap, ladder,
 * combined-monitor, or invalidation transaction records precede the terminal result; read-only
 * make records may also precede workflow results. Failure reports exclude causes, provider
 * payloads, and credentials.
 */
export const runMarketMakingEntrypoint = async (
  application: MarketMakingApplication,
  argv: readonly string[],
  output: EntrypointOutput,
  runtime: Pick<CliRuntimeOptions, 'signal'> = {}
) => {
  try {
    const result = await application.run(argv, {
      ...runtime,
      writeEvent: value => output.writeOut(serializeOutput(value))
    })
    output.writeOut(serializeOutput(result))
    return 0
  } catch (error) {
    output.writeError(failureOutput(error))
    return 1
  }
}
