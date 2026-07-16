import { describe, expect, it } from 'bun:test'

import type { Logger } from '../../src/logger'

import { createRunner } from '../../src/runner/runner'

function spyLogger() {
  const events: { level: string; event: string }[] = []
  const make = (level: string) => (event: string) => {
    events.push({ level, event })
  }
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

describe('createRunner', () => {
  it('runs the tick on a new block and logs block.new', async () => {
    const { logger, events } = spyLogger()
    let ticks = 0
    const runner = createRunner({
      getBlockNumber: async () => 100n,
      tick: async () => {
        ticks += 1
      },
      logger
    })
    await runner.poll()
    expect(ticks).toBe(1)
    expect(events.some(e => e.event === 'block.new')).toBe(true)
  })

  it('swallows a tick error so the loop survives, then ticks again on the next block', async () => {
    const { logger, events } = spyLogger()
    let height = 100n
    let ticks = 0
    const runner = createRunner({
      getBlockNumber: async () => height,
      tick: async () => {
        ticks += 1
        if (ticks === 1) throw new Error('boom')
      },
      logger
    })
    await runner.poll() // tick #1 throws → swallowed
    expect(events.some(e => e.level === 'error' && e.event === 'tick.error')).toBe(true)
    height = 101n
    await runner.poll() // tick #2 runs
    expect(ticks).toBe(2)
  })

  it('runs maintenance before the tick and even when the tick throws', async () => {
    const { logger } = spyLogger()
    const order: string[] = []
    const runner = createRunner({
      getBlockNumber: async () => 100n,
      maintain: async () => {
        order.push('maintain')
      },
      tick: async () => {
        order.push('tick')
        throw new Error('discovery down')
      },
      logger
    })
    await runner.poll()
    // Maintenance ran first, and the tick's throw did not prevent it (before → naturally guaranteed).
    expect(order).toEqual(['maintain', 'tick'])
  })

  it('isolates a maintenance failure: logs queue.maintenance_failed and still runs the tick', async () => {
    const { logger, events } = spyLogger()
    let ticks = 0
    const runner = createRunner({
      getBlockNumber: async () => 100n,
      maintain: async () => {
        throw new Error('rpc down')
      },
      tick: async () => {
        ticks += 1
      },
      logger
    })
    await runner.poll()
    expect(ticks).toBe(1) // maintenance failure did not kill the tick
    expect(events.some(e => e.level === 'error' && e.event === 'queue.maintenance_failed')).toBe(
      true
    )
  })

  it('stop is idempotent and logs shutdown once', async () => {
    const { logger, events } = spyLogger()
    const runner = createRunner({
      getBlockNumber: async () => 1n,
      tick: async () => undefined,
      logger
    })
    runner.start()
    await runner.stop()
    await runner.stop()
    expect(events.filter(e => e.event === 'runner.shutdown')).toHaveLength(1)
  })
})
