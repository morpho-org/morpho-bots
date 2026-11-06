import { describe, expect, test } from 'vitest'

import { terminalMonitoringEvents } from '../../../src/application/monitoring/terminal-monitoring.utils'

describe('terminalMonitoringEvents', () => {
  test('names the failed readiness check when startup halts before any monitor runs', () => {
    const events = terminalMonitoringEvents(
      {
        ready: false,
        checks: [
          { name: 'loan-allowance', status: 'failed', observed: 0n, required: 1n },
          { name: 'chain', status: 'passed', observed: 8453, required: 8453 }
        ]
      },
      'SetupFailedError'
    )

    expect(events).toContainEqual({
      event: 'bot.failed',
      workflow: 'setup-check',
      reason: 'setup-failed',
      errorName: 'SetupFailedError'
    })
    expect(events).toContainEqual({
      event: 'setup.check-failed',
      check: 'loan-allowance',
      status: 'failed'
    })
    expect(events).not.toContainEqual(expect.objectContaining({ check: 'chain' }))
  })

  test('names why a quoter run stopped, and the cause it classified itself', () => {
    expect(
      terminalMonitoringEvents(
        { status: 'halted', reason: 'halted', halt: 'market-failure-budget: ladder' },
        'QuoterRunFailedError'
      )
    ).toEqual([{ event: 'bot.failed', reason: 'halted', errorName: 'QuoterRunFailedError' }])
    expect(
      terminalMonitoringEvents(
        { status: 'halted', reason: 'graph-error', errorName: 'TypeError' },
        'QuoterRunFailedError'
      )
    ).toEqual([{ event: 'bot.failed', reason: 'graph-error', errorName: 'TypeError' }])
    expect(
      terminalMonitoringEvents(
        { status: 'halted', reason: 'cleanup-failed', errorName: 'KernelStopError' },
        'QuoterRunFailedError'
      )
    ).toEqual([{ event: 'bot.failed', reason: 'cleanup-failed', errorName: 'KernelStopError' }])
  })

  test('still reports a top-level failure for an unrecognized report shape', () => {
    expect(terminalMonitoringEvents(undefined, 'UnknownError')).toEqual([
      { event: 'bot.failed', reason: 'unclassified', errorName: 'UnknownError' }
    ])
  })

  test('keeps the wrapper classification for other standalone failures', () => {
    expect(
      terminalMonitoringEvents({ status: 'halted', reason: 'cycle-failed' }, 'CycleError')
    ).toEqual([{ event: 'bot.failed', reason: 'cycle-failed', errorName: 'CycleError' }])
  })

  test("uses a monitor's own cycle error name", () => {
    expect(
      terminalMonitoringEvents(
        { status: 'halted', reason: 'cycle-error', cycleErrorName: 'HttpRequestError' },
        'QuoterRunFailedError'
      )
    ).toEqual([{ event: 'bot.failed', reason: 'cycle-error', errorName: 'HttpRequestError' }])
  })

  test('keeps the wrapper classification for a startup cleanup failure', () => {
    expect(
      terminalMonitoringEvents(
        { reason: 'startup-cleanup-failed', errorName: 'SetupFailedError' },
        'StartupCleanupFailedError'
      )
    ).toEqual([
      {
        event: 'bot.failed',
        reason: 'startup-cleanup-failed',
        errorName: 'StartupCleanupFailedError'
      }
    ])
  })
})
