import type { Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import type { MarketReport } from '../../../src/application/engine/market-report'
import type { QuoterEngine, QuoterStop } from '../../../src/run'

import { terminalMonitoringEvents } from '../../../src/application/monitoring/terminal-monitoring.utils'
import {
  QuoterRunFailedError,
  StartupCleanupFailedError,
  SetupCheckAbortedError,
  ActFailedError,
  QuoterStartError
} from '../../../src/errors'
import { quoterRuns } from '../../../src/infrastructure/engine/quoter-runs'

const marketId: Hex = `0x${'11'.repeat(32)}`
const facts = { bounds: { minimumRateBps: 0n, maximumRateBps: 1n } }
const applied: MarketReport = {
  workflow: 'ladder',
  marketId,
  status: 'applied',
  action: 'publish',
  facts
}
const clean: QuoterStop = { outcome: 'clean', reason: 'stopped' }

const engine = (options: {
  settles?: boolean | 'never'
  rejects?: unknown
  stopped?: QuoterStop
  final?: readonly MarketReport[]
  lastFailed?: readonly MarketReport[]
  setupReady?: boolean
  cycleErrorName?: string
}) => {
  const stopped = Promise.withResolvers<QuoterStop>()
  if (options.stopped) stopped.resolve(options.stopped)
  const fake = {
    settled:
      options.settles === 'never'
        ? new Promise<void>(() => {})
        : options.rejects !== undefined
          ? Promise.reject(options.rejects)
          : options.settles === false
            ? Promise.reject(new ActFailedError('ladder:x', 'refused'))
            : Promise.resolve(),
    stopped: stopped.promise,
    stop: vi.fn(() => stopped.resolve(clean)),
    abandon: vi.fn(async () => {}),
    reports: {
      final: () => options.final ?? [applied],
      lastFailed: () => options.lastFailed,
      setupReady: () => options.setupReady,
      cycleErrorName: () => options.cycleErrorName
    }
  }
  fake.settled.catch(() => {})
  return fake as unknown as QuoterEngine & typeof fake
}

const signal = () => new AbortController().signal

describe('a one-shot run', () => {
  test('returns each market report, without facts unless verbose, and leaves the offers', async () => {
    const running = engine({})
    const runs = quoterRuns(async () => running)

    expect(await runs.runOnce({ signal: signal() })).toEqual([
      { workflow: 'ladder', marketId, status: 'applied', action: 'publish' }
    ])
    expect(await runs.runOnce({ signal: signal(), verbose: true })).toEqual([applied])
    expect(running.abandon).toHaveBeenCalled()
    expect(running.stop).not.toHaveBeenCalled()
  })

  test.each(['failed', 'halted'] as const)('fails when a market ends %s', async status => {
    const final = [{ workflow: 'ladder', marketId, status, stage: 'decision' } as MarketReport]
    const error = await quoterRuns(async () => engine({ final }))
      .runOnce({ signal: signal() })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(QuoterRunFailedError)
    expect((error as QuoterRunFailedError).report).toEqual({
      status: 'failed',
      reason: 'market-failed',
      markets: final
    })
  })

  test('stops a run whose settling failed for its own reason, and surfaces that reason', async () => {
    const failure = new Error('write failed')
    const running = engine({ rejects: failure })
    const error = await quoterRuns(async () => running)
      .runOnce({ signal: signal() })
      .catch((value: unknown) => value)

    expect(error).toBe(failure)
    expect(running.stop).toHaveBeenCalled()
  })

  test('abandons a run aborted while it waits to settle', async () => {
    const running = engine({ settles: 'never' })
    const operator = new AbortController()
    const run = quoterRuns(async () => running)
      .runOnce({ signal: operator.signal })
      .catch((value: unknown) => value)
    await Promise.resolve()
    operator.abort()

    expect(await run).toBeInstanceOf(SetupCheckAbortedError)
    expect(running.abandon).toHaveBeenCalled()
  })

  test('gives up on a run aborted while it was starting', async () => {
    const running = engine({ settles: 'never' })
    const operator = new AbortController()
    const run = quoterRuns(async () => {
      operator.abort()
      return running
    }).runOnce({ signal: operator.signal })

    await expect(run).rejects.toBeInstanceOf(SetupCheckAbortedError)
    expect(running.abandon).toHaveBeenCalled()
  })

  test('fails with the controller report when the run halts', async () => {
    const error = await quoterRuns(async () =>
      engine({ settles: false, stopped: { ...clean, halt: 'act refused' } })
    )
      .runOnce({ signal: signal() })
      .catch((value: unknown) => value)

    expect((error as QuoterRunFailedError).report).toMatchObject({
      status: 'halted',
      reason: 'halted',
      halt: 'act refused',
      markets: [expect.objectContaining({ status: 'applied' })]
    })
  })

  test.each([
    [{ outcome: 'unsafe', reason: 'open', halt: 'x' }, 'cleanup-failed', 'KernelStopError'],
    [
      { outcome: 'clean', reason: 'stopped', halt: 'x', error: new TypeError() },
      'graph-error',
      'TypeError'
    ]
  ] as const)('classifies a run that stopped %#', async (stopped, reason, errorName) => {
    const error = await quoterRuns(async () => engine({ settles: false, stopped }))
      .runOnce({ signal: signal() })
      .catch((value: unknown) => value)

    expect((error as QuoterRunFailedError).report).toMatchObject({ reason, errorName })
  })

  test('reports a start whose cleanup failed as owned offers possibly live', async () => {
    const error = await quoterRuns(async () => {
      throw new QuoterStartError(new TypeError('boom'), { outcome: 'unsafe', reason: 'x' })
    })
      .runOnce({ signal: signal() })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(StartupCleanupFailedError)
  })

  test('reports an aborted start whose cleanup failed, rather than a clean abort', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fail = (outcome: 'clean' | 'unsafe') =>
      quoterRuns(async () => {
        throw new QuoterStartError(abort, { outcome, reason: 'stop requested' })
      })
        .runOnce({ signal: signal() })
        .catch((value: unknown) => value)

    expect(await fail('unsafe')).toBeInstanceOf(StartupCleanupFailedError)
    expect(await fail('clean')).toBe(abort)
  })
})

describe('a continuous run', () => {
  test('stops cleanly on the signal and returns its stop report', async () => {
    const controller = new AbortController()
    const running = engine({ setupReady: true })
    const run = quoterRuns(async () => running).runContinuously({ signal: controller.signal })
    await Promise.resolve()
    controller.abort()

    expect(await run).toEqual({ status: 'stopped', reason: 'signal', setupReady: true })
    expect(running.stop).toHaveBeenCalledWith()
  })

  test.each([
    [{ ...clean, halt: 'market-failure-budget: ladder' }, 'halted'],
    [{ ...clean, halt: 'decision graph failed', error: new TypeError() }, 'graph-error'],
    [{ outcome: 'unsafe', reason: 'open' }, 'cleanup-failed']
  ] as const)('fails a run that stopped %#', async (stopped, reason) => {
    const lastFailed = [{ ...applied, status: 'failed' } as MarketReport]
    const error = await quoterRuns(async () => engine({ stopped, lastFailed }))
      .runContinuously({ signal: signal() })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(QuoterRunFailedError)
    expect((error as QuoterRunFailedError).report).toMatchObject({
      status: 'halted',
      reason,
      markets: [{ status: 'failed' }]
    })
    expect((error as QuoterRunFailedError).report.markets?.[0]).not.toHaveProperty('facts')
  })

  test('names the error of the readiness cycle that halted it', async () => {
    const stopped = { ...clean, halt: 'readiness: setup-failed' }
    const error = await quoterRuns(async () =>
      engine({ stopped, setupReady: false, cycleErrorName: 'TypeError' })
    )
      .runContinuously({ signal: signal() })
      .catch((value: unknown) => value)

    const { report } = error as QuoterRunFailedError
    expect(report).toMatchObject({ reason: 'halted', cycleErrorName: 'TypeError' })
    expect(terminalMonitoringEvents(report, 'QuoterRunFailedError')).toEqual([
      { event: 'bot.failed', reason: 'halted', errorName: 'TypeError' }
    ])
  })
})
