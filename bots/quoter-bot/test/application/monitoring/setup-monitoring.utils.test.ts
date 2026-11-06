import { describe, expect, test } from 'vitest'

import type { SetupCheckReport } from '../../../src/application/setup/setup-check.service'

import { setupMonitoringEvents } from '../../../src/application/monitoring/setup-monitoring.utils'

describe('setupMonitoringEvents', () => {
  test('reports each failed readiness check without leaking its unknown-typed observation', () => {
    const report: SetupCheckReport = {
      ready: false,
      checks: [
        { name: 'native-balance', status: 'failed', observed: 1n, required: 10n },
        { name: 'chain', status: 'passed', observed: 8453, required: 8453 }
      ]
    }

    expect(setupMonitoringEvents(report)).toEqual([
      { event: 'setup.check-failed', check: 'native-balance', status: 'failed' },
      { event: 'cycle.completed', workflow: 'setup-check', status: 'failed' }
    ])
  })

  test('keeps a non-blocking warning off the failure discriminator', () => {
    const report: SetupCheckReport = {
      ready: true,
      checks: [
        { name: 'offers', status: 'warning', observed: {}, required: {} },
        { name: 'chain', status: 'passed', observed: 8453, required: 8453 }
      ]
    }

    expect(setupMonitoringEvents(report)).toEqual([
      { event: 'setup.check-warning', check: 'offers', status: 'warning' },
      { event: 'cycle.completed', workflow: 'setup-check', status: 'ready' }
    ])
  })
})
