import { describe, expect, it } from 'bun:test'
import { parseEther } from 'viem'

import type { Logger, LogLevel } from '../src/logger'

import { createBalanceMonitor } from '../src/balance'

const ADDRESS = `0x${'ab'.repeat(20)}` as const

function captureLogger() {
  const events: { level: LogLevel; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields })
  }
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

describe('createBalanceMonitor', () => {
  it('logs signer.balance at info with a numeric balanceEth', async () => {
    const { logger, events } = captureLogger()
    const monitor = createBalanceMonitor({
      address: ADDRESS,
      read: async () => parseEther('1'),
      logger,
      everyBlocks: 10n
    })
    await monitor.maybeLog(100n)
    const balance = events.find(e => e.event === 'signer.balance')
    expect(balance?.level).toBe('info')
    expect(balance?.fields?.balanceWei).toBe(parseEther('1'))
    expect(balance?.fields?.balanceEth).toBe(1)
    expect(typeof balance?.fields?.balanceEth).toBe('number')
  })

  it('only reads once within the block cadence, then again past the window', async () => {
    const { logger, events } = captureLogger()
    let reads = 0
    const monitor = createBalanceMonitor({
      address: ADDRESS,
      read: async () => {
        reads += 1
        return parseEther('1')
      },
      logger,
      everyBlocks: 10n
    })
    await monitor.maybeLog(100n) // first call always logs
    await monitor.maybeLog(105n) // within window → skipped
    expect(reads).toBe(1)
    await monitor.maybeLog(110n) // delta == everyBlocks → logs again
    expect(reads).toBe(2)
    expect(events.filter(e => e.event === 'signer.balance')).toHaveLength(2)
  })

  it('logs signer.balance_failed at warn when the read throws, without crashing', async () => {
    const { logger, events } = captureLogger()
    const monitor = createBalanceMonitor({
      address: ADDRESS,
      read: async () => {
        throw new Error('rpc unavailable')
      },
      logger,
      everyBlocks: 10n
    })
    await monitor.maybeLog(100n)
    expect(events.some(e => e.event === 'signer.balance')).toBe(false)
    const failed = events.find(e => e.event === 'signer.balance_failed')
    expect(failed?.level).toBe('warn')
    expect(failed?.fields?.address).toBe(ADDRESS)
  })
})
