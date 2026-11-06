import type { BackoffPolicy, PrepareOutcome } from '@repo/controller'
import type { KeyedWrite } from '@repo/engine'
import type { KernelHead, KernelHostOptions } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Address } from 'viem'

import { defineBot, logBackoff, logTasks, task, tasks } from '@repo/controller'
import { lane } from '@repo/engine'
import { tryCatch } from '@repo/utils'

import type { Resolution, ScanDeps } from './sources'

import { createReporter } from './report'
import { revertReason } from './revert.utils'
import { scanBooks } from './sources'

/** A preparation only wraps the scanned calldata in its one step, reading nothing. */
export const PREPARE_TIMEOUT_MS = 1_000

export type ResolverOptions = Readonly<{
  kernel: Omit<KernelHostOptions, 'requests' | 'facts' | 'onActivity'>
  scan: Omit<ScanDeps, 'logger'>
  resolver: Address
  /** How often, at least, every listed market's books are read again. */
  scanIntervalMs: number
  /** How long a scan authorizes resolutions, from when it started. */
  worldValidMs: number
  onHead?: (head: KernelHead) => void
  backoff: BackoffPolicy
  /** Names this run in its intent ids, so a restart's acts never collide with an earlier run's. */
  runId: string
  /** How many resolutions may be prepared or in flight at once. */
  maxReservations: number
  logger: Logger
}>

/** Every crossed market is worth one resolution at a time, and crossed markets take turns. */
const resolutionTask = (_resolution: Resolution, key: string) =>
  task('resolve', { priority: 0n, conflicts: { writes: [`market:${key}`] } })

const resolutionOf = (
  resolver: Address,
  { data }: Resolution,
  validUntil: number
): PrepareOutcome => ({
  ok: true,
  validUntil,
  steps: [{ kind: 'tx', payload: { kind: 'tx', to: resolver, data, value: 0n } }]
})

/**
 * The resolver: every `scanIntervalMs`, at the kernel's head, a scan of every listed market's books
 * simulates the resolution that crosses them as the account that would send it. A market's fact is
 * the calldata of its profitable resolution, so an act holds only while a later scan computes the
 * same bytes, and the kernel simulates those bytes again before it signs them.
 */
export const declareResolver = defineBot('midnight-crossed-books', (b, o: ResolverOptions) => {
  const { logger } = o
  const reporter = createReporter(logger)
  const kernel = b.kernel({ ...o.kernel, onActivity: reporter.reportActivity })
  const scan = b.source('books', {
    level: 'markets',
    at: { everyMs: o.scanIntervalMs },
    queue: 1,
    validForMs: o.worldValidMs,
    logger,
    read: async (head): Promise<KeyedWrite<Resolution>> => {
      o.onHead?.(head)
      const read = await tryCatch(scanBooks(head, { ...o.scan, logger }))
      if (!read.error) return read.data
      logger.warn('tick.error', { reason: revertReason(read.error) })
      return { coverage: 'failed', reason: 'scan' }
    }
  })
  const markets = scan.level
  const crossed = b.fact('markets.crossed', markets, ({ data }) => ({ data }))
  const resolutions = tasks.each(b, 'resolutions', {
    kernel,
    candidates: markets,
    facts: crossed,
    inputs: markets,
    runId: o.runId,
    maxReservations: o.maxReservations,
    backoff: o.backoff,
    policy: resolutionTask,
    prepare: {
      lane: lane('resolutions', { concurrency: 1, queue: 1 }),
      timeoutMs: PREPARE_TIMEOUT_MS,
      handle: async ({ input }) =>
        resolutionOf(o.resolver, input, (o.kernel.now ?? Date.now)() + o.worldValidMs)
    }
  })
  const { backoff } = resolutions
  b.sink('resolutions.log', {
    finishOnStop: true,
    on: { scans: scan.writes, acts: resolutions.events, backoff: backoff.events },
    samples: { markets, view: kernel.view, backoff: backoff.state },
    handle: ({ from, value }, samples) => {
      if (from === 'scans')
        return reporter.reportScan({
          markets: samples.markets(),
          view: samples.view(),
          backoff: samples.backoff(),
          complete: value.coverage === 'complete'
        })
      if (from === 'acts') return logTasks(logger, value)
      logBackoff(logger, value)
    }
  })
  return { kernel, markets, crossed, resolutions }
})
