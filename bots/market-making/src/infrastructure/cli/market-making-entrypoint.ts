import { PositionBootstrapHaltedError } from '../../application/position-bootstrap-halted.error'
import { SetupFailedError } from '../../application/setup-failed.error'

type MarketMakingApplication = { run(argv: readonly string[]): Promise<unknown> }
type EntrypointOutput = { writeOut(value: string): void; writeError(value: string): void }

/**
 * Runs one market-making CLI invocation and maps sanitized output to a process exit contract.
 * @param application - Composed CLI application.
 * @param argv - User arguments without runtime/executable prefixes.
 * @param output - Standard output and error writers.
 * @returns Zero on success and one after a sanitized failure has been emitted.
 * @remarks Halted bootstrap reports are emitted without causes, provider payloads, or credentials.
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
      error instanceof PositionBootstrapHaltedError
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
