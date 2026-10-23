import type { Runner, RunnerOptions } from '@repo/engine'

import { createGraph, createRunner, RunnerFinalizationError } from '@repo/engine'

import type { ReportCommand } from './executor'
import type { KernelHostOptions } from './host'

import { declareKernel } from './host'

/**
 * Runs one kernel on its own runner until it stops. `stopped` resolves with the kernel's report, and
 * rejects if a step fails, after which nothing is executed.
 */
export const startKernel = async (options: KernelHostOptions & Pick<RunnerOptions, 'journal'>) => {
  const g = createGraph('kernel')
  const { nodes, start } = declareKernel(g, options)
  const runner: Runner = createRunner(g.build(), {
    ...(options.now && { now: options.now }),
    journal: options.journal ?? {
      sink: { append: async () => undefined, finalize: async () => undefined },
      capacityBytes: 1_000_000
    }
  })
  try {
    await start(runner)
  } catch (error) {
    const startupError =
      error instanceof Error ? error : new Error('kernel startup failed', { cause: error })
    try {
      await runner.abandon()
    } catch (journalError) {
      throw new RunnerFinalizationError(startupError, journalError)
    }
    return Promise.reject(startupError)
  }
  return { runner, nodes, stopped: runner.stopped as Promise<ReportCommand> }
}
