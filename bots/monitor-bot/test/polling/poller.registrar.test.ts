import type { INestApplicationContext } from '@nestjs/common'

import { SchedulerRegistry, ScheduleModule } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it } from 'vitest'

import { InMemoryCursorStore } from '../../src/cursor/cursor.store'
import { LOGGER } from '../../src/logging/logger.provider'
import { Poller, POLLERS } from '../../src/polling/poller'
import { PollerRegistrar } from '../../src/polling/poller.registrar'
import { capturingDispatcher, fakeLogger } from '../helpers'

// A poller whose tick blocks until release() is called, to observe shutdown behavior mid-tick.
class BlockingPoller extends Poller<number, string> {
  readonly id = 'blocking'
  // Every second — the finest cron granularity; the test waits for real time to pass.
  readonly cron = '* * * * * *'
  tickStarted = false
  tickFinished = false
  private releaseTick: (() => void) | null = null

  release() {
    this.releaseTick?.()
  }

  protected async fetch(cursor: number | null) {
    this.tickStarted = true
    await new Promise<void>(resolve => {
      this.releaseTick = resolve
    })
    this.tickFinished = true
    return { items: [], nextCursor: (cursor ?? 0) + 1 }
  }

  protected toAlerts() {
    return []
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createApp(poller: Poller<number, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot()],
    providers: [
      PollerRegistrar,
      { provide: POLLERS, useValue: [poller] },
      { provide: LOGGER, useValue: fakeLogger() }
    ]
  }).compile()
  return moduleRef.createNestApplication({ logger: false })
}

describe('PollerRegistrar', () => {
  let app: INestApplicationContext | null = null

  afterEach(async () => {
    await app?.close()
    app = null
  })

  it('fails boot loudly on duplicate poller ids', async () => {
    const deps = {
      cursors: new InMemoryCursorStore(),
      dispatcher: capturingDispatcher(),
      logger: fakeLogger()
    }
    const first = new BlockingPoller(deps)
    const second = new BlockingPoller(deps)
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        PollerRegistrar,
        { provide: POLLERS, useValue: [first, second] },
        { provide: LOGGER, useValue: fakeLogger() }
      ]
    }).compile()
    const duplicateApp = moduleRef.createNestApplication({ logger: false })
    await expect(duplicateApp.init()).rejects.toThrow('Duplicate poller id: blocking')
    first.release()
    await duplicateApp.close()
  })

  it('registers one cron job per poller on bootstrap', async () => {
    const deps = {
      cursors: new InMemoryCursorStore(),
      dispatcher: capturingDispatcher(),
      logger: fakeLogger()
    }
    const poller = new BlockingPoller(deps)
    app = await createApp(poller)
    await app.init()

    const registry = app.get(SchedulerRegistry)
    expect([...registry.getCronJobs().keys()]).toEqual(['blocking'])
    poller.release()
  })

  it('shutdown awaits the in-flight tick before resolving', async () => {
    const deps = {
      cursors: new InMemoryCursorStore(),
      dispatcher: capturingDispatcher(),
      logger: fakeLogger()
    }
    const poller = new BlockingPoller(deps)
    app = await createApp(poller)
    await app.init()

    // Wait for the 1s-granularity cron to actually start a tick. Time-dependent by nature: the
    // cron engine only fires on wall-clock second boundaries, so exact timing is not feasible.
    const deadline = Date.now() + 2_500
    while (!poller.tickStarted && Date.now() < deadline) await delay(25)
    expect(poller.tickStarted).toBe(true)

    let closed = false
    const closing = app.close().then(() => {
      closed = true
    })

    // close() must not resolve while the tick is still blocked mid-flight.
    await delay(150)
    expect(closed).toBe(false)
    expect(poller.tickFinished).toBe(false)

    poller.release()
    await closing
    expect(poller.tickFinished).toBe(true)
    app = null
  })
})
