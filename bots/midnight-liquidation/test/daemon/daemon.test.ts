import { describe, expect, it } from 'bun:test'

import type { Logger } from '../../src/logger'

import { createDaemon } from '../../src/daemon/daemon'

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

describe('createDaemon', () => {
  it('runs the tick on a new block and logs block.new', async () => {
    const { logger, events } = spyLogger()
    let ticks = 0
    const daemon = createDaemon({
      getBlockNumber: async () => 100n,
      tick: async () => {
        ticks += 1
      },
      logger
    })
    await daemon.poll()
    expect(ticks).toBe(1)
    expect(events.some(e => e.event === 'block.new')).toBe(true)
  })

  it('swallows a tick error so the loop survives, then ticks again on the next block', async () => {
    const { logger, events } = spyLogger()
    let height = 100n
    let ticks = 0
    const daemon = createDaemon({
      getBlockNumber: async () => height,
      tick: async () => {
        ticks += 1
        if (ticks === 1) throw new Error('boom')
      },
      logger
    })
    await daemon.poll() // tick #1 throws → swallowed
    expect(events.some(e => e.level === 'error' && e.event === 'tick.error')).toBe(true)
    height = 101n
    await daemon.poll() // tick #2 runs
    expect(ticks).toBe(2)
  })

  it('stop is idempotent and logs shutdown once', async () => {
    const { logger, events } = spyLogger()
    const daemon = createDaemon({
      getBlockNumber: async () => 1n,
      tick: async () => undefined,
      logger
    })
    daemon.start()
    await daemon.stop()
    await daemon.stop()
    expect(events.filter(e => e.event === 'daemon.shutdown')).toHaveLength(1)
  })
})
