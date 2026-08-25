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
    expect(events).toContainEqual({ event: 'setup.check-failed', check: 'loan-allowance' })
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

  test('never emits a record without an allowlisted classification', () => {
    const events = terminalMonitoringEvents(
      { status: 'halted', reason: 'cleanup-failed' },
      'LadderMonitorHaltedError'
    )

    expect(events).toEqual([
      { event: 'bot.failed', reason: 'cleanup-failed', errorName: 'LadderMonitorHaltedError' }
    ])
  })
})
