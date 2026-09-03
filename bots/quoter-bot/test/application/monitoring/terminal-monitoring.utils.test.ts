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

  test('identifies which supervised workflow ended the fail-together lifecycle', () => {
    const events = terminalMonitoringEvents(
      {
        status: 'halted',
        reason: 'workflow-error',
        workflows: {
          setupCheck: { status: 'fulfilled', report: { status: 'stopped', reason: 'signal' } },
          bootstrap: { status: 'rejected', errorName: 'BootstrapAdapterError' },
          ladder: {
            status: 'fulfilled',
            report: {
              status: 'halted',
              reason: 'cycle-failed',
              cycleErrorName: 'LadderAdapterError'
            }
          }
        }
      },
      'QuoterBotMonitorHaltedError'
    )

    expect(events).toContainEqual({
      event: 'bot.failed',
      workflow: 'bootstrap',
      reason: 'workflow-error',
      errorName: 'BootstrapAdapterError'
    })
    expect(events).toContainEqual({
      event: 'bot.failed',
      workflow: 'ladder',
      reason: 'cycle-failed',
      errorName: 'LadderAdapterError'
    })
    expect(events.filter(event => event.event === 'bot.failed')).toHaveLength(3)
  })

  test('still reports a top-level failure for an unrecognized report shape', () => {
    expect(terminalMonitoringEvents(undefined, 'UnknownError')).toEqual([
      { event: 'bot.failed', reason: 'unclassified', errorName: 'UnknownError' }
    ])
  })

  test('uses cleanup error names for standalone failures', () => {
    const events = terminalMonitoringEvents(
      { status: 'halted', reason: 'cleanup-failed', cleanup: { errorName: 'CleanupError' } },
      'LadderMonitorHaltedError'
    )

    expect(events).toEqual([
      { event: 'bot.failed', reason: 'cleanup-failed', errorName: 'CleanupError' }
    ])
  })

  test('keeps the wrapper classification for other standalone failures', () => {
    expect(
      terminalMonitoringEvents({ status: 'halted', reason: 'cycle-failed' }, 'CycleError')
    ).toEqual([{ event: 'bot.failed', reason: 'cycle-failed', errorName: 'CycleError' }])
  })

  test('uses cleanup error names for combined workflow failures', () => {
    const events = terminalMonitoringEvents(
      {
        status: 'halted',
        reason: 'workflow-error',
        workflows: {
          setupCheck: { status: 'fulfilled', report: { status: 'stopped', reason: 'signal' } },
          bootstrap: {
            status: 'fulfilled',
            report: {
              status: 'halted',
              reason: 'cleanup-failed',
              cleanup: { status: 'failed', errorName: 'BootstrapCleanupError' }
            }
          },
          ladder: {
            status: 'fulfilled',
            report: {
              status: 'halted',
              reason: 'cleanup-failed',
              cleanup: { status: 'failed', errorName: 'LadderCleanupError' }
            }
          }
        }
      },
      'QuoterBotMonitorHaltedError'
    )

    expect(events).toContainEqual({
      event: 'bot.failed',
      workflow: 'bootstrap',
      reason: 'cleanup-failed',
      errorName: 'BootstrapCleanupError'
    })
    expect(events).toContainEqual({
      event: 'bot.failed',
      workflow: 'ladder',
      reason: 'cleanup-failed',
      errorName: 'LadderCleanupError'
    })
  })
})
