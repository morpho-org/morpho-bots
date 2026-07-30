import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { SetupFailedError } from '../../application/setup/setup-failed.error'

type MarketMakingApplication = { run(argv: readonly string[]): Promise<unknown> }
type EntrypointOutput = { writeOut(value: string): void; writeError(value: string): void }

/**
 * Runs one market-making CLI invocation and maps sanitized output to a process exit contract.
 * @param application - Composed CLI application.
 * @param argv - User arguments without runtime/executable prefixes.
 * @param output - Standard output and error writers.
 * @returns Zero on success and one after a sanitized failure has been emitted.
 * @remarks Each output value is one JSON Lines record. Read-only make records may precede the final
 * cycle report on standard output. Halted reports exclude causes, provider payloads, and credentials.
 */
export const runMarketMakingEntrypoint = async (
  application: MarketMakingApplication,
  argv: readonly string[],
  output: EntrypointOutput
) => {
  try {
    const result = await application.run(argv)
    output.writeOut(typeof result === 'string' ? result : JSON.stringify(result))
    return 0
  } catch (error) {
    const message =
      error instanceof LadderCycleHaltedError
        ? JSON.stringify(error.report)
        : error instanceof PositionBootstrapHaltedError
          ? JSON.stringify(error.report)
          : error instanceof SetupFailedError
            ? JSON.stringify(error.report)
            : error instanceof Error
              ? error.message
              : 'Unknown failure'
    output.writeError(message)
    return 1
  }
}
