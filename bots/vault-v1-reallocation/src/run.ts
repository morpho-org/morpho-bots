import type { Runner, RunnerOptions } from '@repo/engine'
import type { ReportCommand } from '@repo/kernel'

import { createRunner, DEFAULT_JOURNAL_IO_TIMEOUT_MS } from '@repo/engine'
import { tryCatch } from '@repo/utils'

import type { ReallocatorOptions } from './graph'

import { declareReallocator } from './graph'

/**
 * Runs the reallocator until its kernel stops.
 * @param now - The one clock the kernel and the runner share.
 * @param journal - The run's journal; it is finalized if the graph or its runner cannot be made.
 */
export const startReallocator = async (
  options: ReallocatorOptions & {
    now?: () => number
    journal: NonNullable<RunnerOptions['journal']>
  }
) => {
  const now = options.now ?? Date.now
  const { journal } = options
  let declared: ReturnType<typeof declareReallocator>
  let runner: Runner
  try {
    declared = declareReallocator({ ...options, kernel: { ...options.kernel, now } })
    runner = createRunner(declared.graph, { now, journal })
  } catch (error) {
    const finalized = await tryCatch(
      journal.sink.finalize(
        AbortSignal.timeout(journal.ioTimeoutMs ?? DEFAULT_JOURNAL_IO_TIMEOUT_MS),
        {
          clean: false
        }
      )
    )
    throw finalized.error
      ? new AggregateError(
          [error, finalized.error],
          'the bot did not start and its journal did not finalize'
        )
      : error
  }
  const nodes = declared
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
