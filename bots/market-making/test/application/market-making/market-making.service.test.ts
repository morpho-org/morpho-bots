import { describe, expect, test } from 'bun:test'

import type {
  MarketMakingBootstrapMonitor,
  MarketMakingEvent,
  MarketMakingLadderMonitor,
  MarketMakingSetupMonitor
} from '../../../src/application/market-making/market-making.service'

import { MarketMakingService } from '../../../src/application/market-making/market-making.service'

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

const stoppedSetupReport = {
  status: 'stopped' as const,
  reason: 'signal' as const,
  cycles: 1
}

const stoppedBootstrapReport = {
  status: 'stopped' as const,
  reason: 'signal' as const,
  cycles: 1,
  cleanup: { status: 'applied' as const }
}

const stoppedLadderReport = {
  status: 'stopped' as const,
  reason: 'signal' as const,
  cycles: 1,
  cleanup: { status: 'applied' as const }
}

const waitingBootstrapMonitor = (drained: string[]): MarketMakingBootstrapMonitor => ({
  runContinuously: async ({ signal, onCycle }) => {
    await onCycle?.([{ status: 'observed', action: 'rest' }])
    await waitForAbort(signal)
    drained.push('bootstrap')
    return stoppedBootstrapReport
  }
})

const waitingLadderMonitor = (drained: string[]): MarketMakingLadderMonitor => ({
  runContinuously: async ({ signal, onCycle }) => {
    await onCycle?.([{ status: 'observed' }])
    await waitForAbort(signal)
    drained.push('ladder')
    return stoppedLadderReport
  }
})

describe('MarketMakingService', () => {
  test('runs the initial ladder cycle before the ongoing bootstrap cycle', async () => {
    const events: string[] = []
    const controller = new AbortController()
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async ({ signal }) => {
        await waitForAbort(signal)
        return stoppedSetupReport
      }
    }
    const bootstrap: MarketMakingBootstrapMonitor = {
      runContinuously: async ({ signal, runOperation }) => {
        if (!runOperation) throw new Error('missing operation queue')
        await runOperation(async () => {
          events.push('bootstrap:cycle')
          controller.abort()
        })
        await waitForAbort(signal)
        await runOperation(async () => {})
        return stoppedBootstrapReport
      }
    }
    const ladder: MarketMakingLadderMonitor = {
      runContinuously: async ({ signal, runOperation }) => {
        if (!runOperation) throw new Error('missing operation queue')
        await runOperation(async () => {
          events.push('ladder:cycle')
        })
        await waitForAbort(signal)
        await runOperation(async () => {})
        return stoppedLadderReport
      }
    }

    const report = await new MarketMakingService(setup, bootstrap, ladder).runContinuously({
      signal: controller.signal
    })

    expect(report.status).toBe('stopped')
    expect(events).toEqual(['ladder:cycle', 'bootstrap:cycle'])
  })

  test('aborts peer workflows and waits for writer cleanup after one workflow halts', async () => {
    const failedReport = { ready: false, checks: [] }
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async ({ onCycle }) => {
        await onCycle?.(failedReport)
        return {
          status: 'halted',
          reason: 'setup-failed',
          cycles: 1,
          lastReport: failedReport
        }
      }
    }
    const drained: string[] = []
    const events: MarketMakingEvent[] = []
    const service = new MarketMakingService(
      setup,
      waitingBootstrapMonitor(drained),
      waitingLadderMonitor(drained)
    )

    const report = await service.runContinuously({
      signal: new AbortController().signal,
      onEvent: event => {
        events.push(event)
      }
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'workflow-halted',
      workflows: {
        setupCheck: { status: 'fulfilled', report: { status: 'halted' } },
        bootstrap: { status: 'fulfilled', report: stoppedBootstrapReport },
        ladder: { status: 'fulfilled', report: stoppedLadderReport }
      }
    })
    expect(drained).toEqual(['ladder', 'bootstrap'])
    expect(events).toEqual([
      { event: 'market-making.cycle', workflow: 'setup-check', report: failedReport },
      {
        event: 'market-making.cycle',
        workflow: 'ladder',
        results: [{ status: 'observed' }]
      },
      {
        event: 'market-making.cycle',
        workflow: 'bootstrap',
        results: [{ status: 'observed', action: 'rest' }]
      }
    ])
  })

  test('aborts writers before awaiting failed setup event delivery', async () => {
    const failedReport = { ready: false, checks: [] }
    let releaseEventDelivery: (() => void) | undefined
    let markEventStarted: (() => void) | undefined
    let markWriterChecked: (() => void) | undefined
    const eventDelivery = new Promise<void>(resolve => {
      releaseEventDelivery = resolve
    })
    const eventStarted = new Promise<void>(resolve => {
      markEventStarted = resolve
    })
    const writerChecked = new Promise<void>(resolve => {
      markWriterChecked = resolve
    })
    let writerObservedAbort = false
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async ({ onCycle }) => {
        await onCycle?.(failedReport)
        return {
          status: 'halted',
          reason: 'setup-failed',
          cycles: 1,
          lastReport: failedReport
        }
      }
    }
    const bootstrap: MarketMakingBootstrapMonitor = {
      runContinuously: async ({ signal, runOperation }) => {
        if (!runOperation) throw new Error('missing operation queue')
        await runOperation(async () => {
          writerObservedAbort = signal.aborted
          markWriterChecked?.()
        })
        return stoppedBootstrapReport
      }
    }
    const ladder: MarketMakingLadderMonitor = {
      runContinuously: async ({ signal }) => {
        await waitForAbort(signal)
        return stoppedLadderReport
      }
    }
    const running = new MarketMakingService(setup, bootstrap, ladder).runContinuously({
      signal: new AbortController().signal,
      onEvent: async event => {
        if (event.event !== 'market-making.cycle' || event.workflow !== 'setup-check') return
        markEventStarted?.()
        await eventDelivery
      }
    })

    await eventStarted
    await writerChecked
    expect(writerObservedAbort).toBe(true)
    releaseEventDelivery?.()

    expect(await running).toMatchObject({ status: 'halted', reason: 'workflow-halted' })
  })

  test('serializes writer cycles and aborts peers before cleanup begins', async () => {
    const events: string[] = []
    const failedResults = [{ status: 'failed', stage: 'make' }]
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async ({ signal }) => {
        await waitForAbort(signal)
        return stoppedSetupReport
      }
    }
    const bootstrap: MarketMakingBootstrapMonitor = {
      runContinuously: async ({ signal, runOperation }) => {
        if (!runOperation) throw new Error('missing operation queue')
        await runOperation(async () => {
          if (signal.aborted) {
            events.push('bootstrap:cycle-skipped')
            return
          }
          events.push('bootstrap:cycle')
        })
        events.push(`bootstrap:cleanup-aborted:${signal.aborted}`)
        await runOperation(async () => {
          events.push('bootstrap:cleanup-write')
        })
        return stoppedBootstrapReport
      }
    }
    const ladder: MarketMakingLadderMonitor = {
      runContinuously: async ({ signal, onCycle, runOperation }) => {
        if (!runOperation) throw new Error('missing operation queue')
        await runOperation(async () => {
          events.push('ladder:cycle')
          await onCycle?.(failedResults)
        })
        events.push(`ladder:cleanup-aborted:${signal.aborted}`)
        await runOperation(async () => {
          events.push('ladder:cleanup-write')
        })
        return {
          status: 'halted',
          reason: 'cycle-failed',
          cycles: 1,
          cleanup: { status: 'applied' }
        }
      }
    }

    const report = await new MarketMakingService(setup, bootstrap, ladder).runContinuously({
      signal: new AbortController().signal
    })

    expect(report).toMatchObject({ status: 'halted', reason: 'workflow-halted' })
    expect(events).toContain('ladder:cycle')
    expect(events).toContain('bootstrap:cycle-skipped')
    expect(events).not.toContain('bootstrap:cycle')
    expect(events).toContain('bootstrap:cleanup-aborted:true')
    expect(events).toContain('ladder:cleanup-aborted:true')
    expect(events.indexOf('ladder:cycle')).toBeLessThan(events.indexOf('ladder:cleanup-write'))
  })

  test('returns a clean stop only after an operator signal drains every workflow', async () => {
    const started: string[] = []
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async ({ signal }) => {
        started.push('setup')
        await waitForAbort(signal)
        return stoppedSetupReport
      }
    }
    const bootstrap: MarketMakingBootstrapMonitor = {
      runContinuously: async ({ signal }) => {
        started.push('bootstrap')
        await waitForAbort(signal)
        return stoppedBootstrapReport
      }
    }
    const ladder: MarketMakingLadderMonitor = {
      runContinuously: async ({ signal }) => {
        started.push('ladder')
        await waitForAbort(signal)
        return stoppedLadderReport
      }
    }
    const controller = new AbortController()
    const running = new MarketMakingService(setup, bootstrap, ladder).runContinuously({
      signal: controller.signal
    })

    await Promise.resolve()
    controller.abort()

    expect(await running).toEqual({
      status: 'stopped',
      reason: 'signal',
      workflows: {
        setupCheck: { status: 'fulfilled', report: stoppedSetupReport },
        bootstrap: { status: 'fulfilled', report: stoppedBootstrapReport },
        ladder: { status: 'fulfilled', report: stoppedLadderReport }
      }
    })
    expect(started).toEqual(['setup', 'ladder', 'bootstrap'])
  })

  test('sanitizes a rejected workflow and waits for both writer monitors to drain', async () => {
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async () => {
        throw new TypeError('provider https://rpc.example/?token=secret')
      }
    }
    const drained: string[] = []
    const service = new MarketMakingService(
      setup,
      waitingBootstrapMonitor(drained),
      waitingLadderMonitor(drained)
    )

    const report = await service.runContinuously({ signal: new AbortController().signal })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'workflow-error',
      workflows: {
        setupCheck: { status: 'rejected', errorName: 'TypeError' }
      }
    })
    expect(drained).toEqual(['ladder', 'bootstrap'])
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(JSON.stringify(report)).not.toContain('rpc.example')
  })

  test('classifies a workflow that stops without an operator signal as unexpected', async () => {
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async () => stoppedSetupReport
    }
    const drained: string[] = []
    const service = new MarketMakingService(
      setup,
      waitingBootstrapMonitor(drained),
      waitingLadderMonitor(drained)
    )

    const report = await service.runContinuously({ signal: new AbortController().signal })

    expect(report).toMatchObject({ status: 'halted', reason: 'workflow-stopped' })
    expect(drained).toEqual(['ladder', 'bootstrap'])
  })

  test('preserves an unexpected stop when an operator signal arrives during peer cleanup', async () => {
    let releaseBootstrapDrain: (() => void) | undefined
    let observePeerAbort: (() => void) | undefined
    const peerAborted = new Promise<void>(resolve => {
      observePeerAbort = resolve
    })
    const bootstrapDrain = new Promise<void>(resolve => {
      releaseBootstrapDrain = resolve
    })
    const setup: MarketMakingSetupMonitor = {
      runContinuously: async () => stoppedSetupReport
    }
    const bootstrap: MarketMakingBootstrapMonitor = {
      runContinuously: async ({ signal }) => {
        await waitForAbort(signal)
        observePeerAbort?.()
        await bootstrapDrain
        return stoppedBootstrapReport
      }
    }
    const ladder: MarketMakingLadderMonitor = {
      runContinuously: async ({ signal }) => {
        await waitForAbort(signal)
        return stoppedLadderReport
      }
    }
    const controller = new AbortController()
    const running = new MarketMakingService(setup, bootstrap, ladder).runContinuously({
      signal: controller.signal
    })

    await peerAborted
    controller.abort()
    releaseBootstrapDrain?.()

    expect(await running).toMatchObject({ status: 'halted', reason: 'workflow-stopped' })
  })
})
