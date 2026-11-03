import type { Runner, RunnerOptions } from '@repo/engine'
import type { ReportCommand } from '@repo/kernel'

import { createRunner, DEFAULT_JOURNAL_IO_TIMEOUT_MS } from '@repo/engine'
import { tryCatch } from '@repo/utils'

import type { LiquidatorOptions } from './graph'

import { declareLiquidator } from './graph'

/**
 * Runs the liquidator until its kernel stops.
 * @param now - The one clock the kernel and the runner share.
 * @param journal - The run's journal; it is finalized if the graph or the runner cannot be created.
 */
export const startLiquidator = async (
  options: LiquidatorOptions & {
    now?: () => number
    journal: NonNullable<RunnerOptions['journal']>
  }
) => {
  const now = options.now ?? Date.now
  const { journal } = options
  let runner: Runner
  let nodes: Omit<ReturnType<typeof declareLiquidator>, 'graph'>
  try {
    const { graph, ...declared } = declareLiquidator({
      ...options,
      kernel: { ...options.kernel, now }
    })
    nodes = declared
    runner = createRunner(graph, { now, journal })
  } catch (error) {
    const finalized = await tryCatch(
      journal.sink.finalize(
        AbortSignal.timeout(journal.ioTimeoutMs ?? DEFAULT_JOURNAL_IO_TIMEOUT_MS),
        { clean: false }
      )
    )
    throw finalized.error
      ? new AggregateError(
          [error, finalized.error],
          'the graph or runner was not created and its journal did not finalize'
        )
      : error
  }
  try {
    await nodes.kernel.start(runner)
  } catch (error) {
    const abandoned = await tryCatch(runner.abandon())
    throw abandoned.error
      ? new AggregateError(
          [error, abandoned.error],
          'the kernel did not start and the runner did not abandon'
        )
      : error
  }
  return {
    runner,
    nodes,
    stop: () => runner.push(nodes.kernel.nodes.requests, { type: 'Stop' }),
    stopped: runner.stopped as Promise<ReportCommand>
  }
}
