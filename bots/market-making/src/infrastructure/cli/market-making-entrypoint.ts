import type { CliRuntimeOptions } from './cli'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../application/ladder/ladder-monitor-halted.error'
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

/**
 * Runs one market-making CLI invocation and maps sanitized output to a process exit contract.
 * @param application - Composed CLI application.
 * @param argv - User arguments without runtime/executable prefixes.
 * @param output - Standard output and error writers.
 * @param runtime - Optional graceful-shutdown signal for continuous commands.
 * @returns Zero on success and one after a sanitized failure has been emitted.
 * @remarks Each output value is one JSON Lines record. Continuous readiness, bootstrap, or ladder
 * cycle records precede the terminal monitor report; read-only make records may also precede
 * workflow results. Halted reports exclude causes, provider payloads, and credentials.
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
    const message =
      error instanceof SetupMonitorHaltedError
        ? serializeOutput(error.report)
        : error instanceof LadderMonitorHaltedError
          ? serializeOutput(error.report)
          : error instanceof LadderCycleHaltedError
            ? serializeOutput(error.report)
            : error instanceof PositionBootstrapHaltedError
              ? serializeOutput(error.report)
              : error instanceof SetupFailedError
                ? serializeOutput(error.report)
                : error instanceof Error
                  ? error.message
                  : 'Unknown failure'
    output.writeError(message)
    return 1
  }
}
