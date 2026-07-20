import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import type { Logger } from '@repo/bot-kit'

import { Inject, Injectable } from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import { ensureError } from '@repo/utils'
import { CronJob } from 'cron'

import { LOGGER } from '../logging/logger.provider'
import { POLLERS, type Poller } from './poller'

// The thin wiring the cron engine cannot own: collect the pollers, register one cron job per
// poller, and await every in-flight tick on shutdown so SIGTERM never cuts a tick between
// "alerts sent" and "cursor saved". Overlap prevention itself is the engine's job
// (waitForCompletion: a tick that would overlap a running one is skipped; the cursor guarantees
// the next tick picks up everything missed).
@Injectable()
export class PollerRegistrar implements OnApplicationBootstrap, OnApplicationShutdown {
  // Own references, not the SchedulerRegistry: @nestjs/schedule's orchestrator empties the
  // registry on shutdown with fire-and-forget stop() calls — and it can run before this hook,
  // leaving nothing to await. stop() is idempotent, so double-stopping is harmless while our
  // awaited call is what actually blocks until the in-flight tick completes.
  private readonly jobs = new Map<string, CronJob>()

  constructor(
    @Inject(POLLERS) private readonly pollers: Poller<unknown, unknown>[],
    private readonly registry: SchedulerRegistry,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  onApplicationBootstrap() {
    // Validate ids before starting ANY job: a mid-loop throw would leave earlier pollers' cron
    // timers running on a failed boot, keeping the event loop alive as a zombie.
    const ids = new Set<string>()
    for (const poller of this.pollers) {
      if (ids.has(poller.id)) throw new Error(`Duplicate poller id: ${poller.id}`)
      ids.add(poller.id)
    }
    for (const poller of this.pollers) {
      const job = CronJob.from({
        cronTime: poller.cron,
        onTick: () => poller.pollOnce(),
        waitForCompletion: true,
        errorHandler: error =>
          this.logger.error('poll.error', {
            pollerId: poller.id,
            error: ensureError(error).message
          }),
        start: true
      })
      this.jobs.set(poller.id, job)
      // Also visible in the SchedulerRegistry for operational introspection.
      this.registry.addCronJob(poller.id, job)
      this.logger.info('poller.registered', { pollerId: poller.id, cron: poller.cron })
    }
  }

  async onApplicationShutdown() {
    await Promise.all([...this.jobs.values()].map(job => job.stop()))
    this.logger.info('pollers.stopped', { count: this.jobs.size })
  }
}
