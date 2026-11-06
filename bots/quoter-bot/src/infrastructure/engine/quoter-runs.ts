import type { MarketReport } from '../../application/engine/market-report'
import type { QuoterRunReport } from '../../errors'
import type { QuoterEngine, QuoterStop } from '../../run'

import {
  adapterOperationField,
  operatorErrorName
} from '../../application/monitoring/operator-error-name.utils'
import {
  QuoterRunFailedError,
  StartupCleanupFailedError,
  SetupCheckAbortedError,
  ActFailedError,
  QuoterStartError
} from '../../errors'

/** Starts the engine for one command's strategies. */
export type EngineStarter = (options: {
  signal: AbortSignal
  until?: 'settled'
}) => Promise<QuoterEngine>

type EventWriter = (value: unknown) => void | Promise<void>

/**
 * Surfaces a failed start the way writer startup reported it: the kernel was stopped first; when
 * it stopped with commitments open, `StartupCleanupFailedError`, otherwise the original failure.
 */
const rethrowStartup = async (error: unknown, writeEvent?: EventWriter): Promise<never> => {
  if (!(error instanceof QuoterStartError)) throw error
  const aborted = error.cause instanceof Error && error.cause.name === 'AbortError'
  // An operator's abort is not a failure once the stop withdrew everything, so nothing is reported.
  if (aborted && error.report.outcome === 'clean') throw error.cause
  const cause = { errorName: operatorErrorName(error.cause), ...adapterOperationField(error.cause) }
  if (error.report.outcome !== 'clean') {
    const failed = { status: 'failed' as const, errorName: 'KernelStopError' }
    throw new StartupCleanupFailedError({
      reason: 'startup-cleanup-failed',
      ...cause,
      ladder: failed,
      bootstrap: failed
    })
  }
  const succeeded = { status: 'succeeded' as const, transactions: [] }
  await Promise.resolve(
    writeEvent?.({
      event: 'startup.owned-offers-cancelled',
      ...cause,
      ladder: succeeded,
      bootstrap: succeeded
    })
  ).catch(() => undefined)
  throw error.cause
}

const ending = (report: QuoterStop) => ({
  reason:
    report.outcome !== 'clean'
      ? ('cleanup-failed' as const)
      : report.error !== undefined
        ? ('graph-error' as const)
        : report.halt !== undefined
          ? ('halted' as const)
          : ('signal' as const),
  ...(report.halt === undefined ? {} : { halt: report.halt }),
  ...(report.outcome !== 'clean'
    ? { errorName: 'KernelStopError' }
    : report.error !== undefined
      ? { errorName: operatorErrorName(report.error) }
      : {})
})

/** `--verbose` prints what each market observed beside its classification. */
const printable = (reports: readonly MarketReport[], verbose: boolean): readonly MarketReport[] =>
  verbose ? reports : reports.map(({ facts: _facts, ...report }) => report as MarketReport)

const failing = (report: MarketReport) => report.status === 'failed' || report.status === 'halted'

/**
 * The commands that run the quoter. A one-shot run waits until every market is steady, reports each
 * market's final report, and leaves the kernel's offers for the next start; a continuous run quotes
 * until the signal, and stopping withdraws everything.
 * @param start - Starts the quoter engine for one run.
 * @param writeEvent - Writes startup-failure records; when absent, none are written.
 * @returns `runOnce` and `runContinuously`.
 * @throws `QuoterRunFailedError` when a run halts, its graph fails, its kernel cannot clean up, or a
 * one-shot run ends with a market failed or halted.
 */
export const quoterRuns = (start: EngineStarter, writeEvent?: EventWriter) => ({
  /** Runs until every market is steady, then returns each market's final report. */
  runOnce: async (parameters: {
    signal: AbortSignal
    verbose?: boolean
  }): Promise<readonly MarketReport[]> => {
    const { signal } = parameters
    if (signal.aborted) throw new SetupCheckAbortedError()
    let engine: QuoterEngine
    try {
      engine = await start({ signal, until: 'settled' })
    } catch (error) {
      return rethrowStartup(error, writeEvent)
    }
    const aborted = new Promise<'aborted'>(resolve => {
      signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      if (signal.aborted) resolve('aborted')
    })
    const settled = await Promise.race([
      engine.settled.then(
        () => true as const,
        (error: unknown) => ({ error })
      ),
      aborted
    ])
    if (settled === 'aborted') {
      await engine.abandon()
      throw new SetupCheckAbortedError()
    }
    if (settled !== true) engine.stop()
    const stopped = settled === true ? undefined : await engine.stopped
    await engine.abandon()
    if (settled !== true && !(settled.error instanceof ActFailedError)) throw settled.error
    const markets = printable(engine.reports.final(), parameters.verbose === true)
    if (stopped) throw new QuoterRunFailedError({ status: 'halted', ...ending(stopped), markets })
    if (markets.some(failing))
      throw new QuoterRunFailedError({ status: 'failed', reason: 'market-failed', markets })
    return markets
  },
  /** Quotes until `signal` aborts, then withdraws everything and returns the run's report. */
  runContinuously: async (parameters: {
    signal: AbortSignal
    verbose?: boolean
  }): Promise<QuoterRunReport> => {
    const { signal } = parameters
    let engine: QuoterEngine
    try {
      engine = await start({ signal })
    } catch (error) {
      return rethrowStartup(error, writeEvent)
    }
    const stop = () => engine.stop()
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    const stopped = await engine.stopped
    signal.removeEventListener('abort', stop)
    const ended = ending(stopped)
    const setupReady = engine.reports.setupReady()
    const cycleErrorName = engine.reports.cycleErrorName()
    const lastFailed = engine.reports.lastFailed()
    const report: QuoterRunReport = {
      status: ended.reason === 'signal' ? 'stopped' : 'halted',
      ...ended,
      ...(setupReady === undefined ? {} : { setupReady }),
      ...(cycleErrorName === undefined ? {} : { cycleErrorName }),
      ...(lastFailed ? { markets: printable(lastFailed, parameters.verbose === true) } : {})
    }
    if (report.status !== 'stopped') throw new QuoterRunFailedError(report)
    return report
  }
})
