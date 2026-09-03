import { describe, expect, test } from 'vitest'

import {
  createOperationQueue,
  cycleHasFailure,
  cycleRequiresHalt,
  waitForMonitorInterval
} from '../src/monitor.utils'

describe('waitForMonitorInterval', () => {
  test('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const start = performance.now()
    await waitForMonitorInterval(60_000, controller.signal)

    expect(performance.now() - start).toBeLessThan(1_000)
  })

  test('resolves early when the signal aborts during the wait', async () => {
    const controller = new AbortController()

    const wait = waitForMonitorInterval(60_000, controller.signal)
    controller.abort()
    await wait

    expect(controller.signal.aborted).toBe(true)
  })

  test('resolves after the interval elapses without an abort', async () => {
    const controller = new AbortController()

    const start = performance.now()
    await waitForMonitorInterval(10, controller.signal)

    expect(performance.now() - start).toBeGreaterThanOrEqual(5)
  })
})

describe('createOperationQueue', () => {
  test('runs operations one at a time in submission order', async () => {
    const enqueue = createOperationQueue()
    const order: string[] = []
    let release = () => {}
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })

    const first = enqueue(async () => {
      order.push('first-start')
      await blocked
      order.push('first-end')
    })
    const second = enqueue(async () => {
      order.push('second')
    })

    release()
    await Promise.all([first, second])

    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  test('keeps accepting operations after a rejection', async () => {
    const enqueue = createOperationQueue()

    await expect(
      enqueue(() => Promise.reject(new RangeError('rejected operation')))
    ).rejects.toBeInstanceOf(RangeError)
    await expect(enqueue(async () => 'recovered')).resolves.toBe('recovered')
  })

  test('returns each operation result to its own caller', async () => {
    const enqueue = createOperationQueue()

    const results = await Promise.all([
      enqueue(async () => 1),
      enqueue(async () => 2),
      enqueue(async () => 3)
    ])

    expect(results).toEqual([1, 2, 3])
  })
})

describe('cycleHasFailure', () => {
  test('reports failure for failed or halted results', () => {
    expect(cycleHasFailure([{ status: 'published' }, { status: 'failed' }])).toBe(true)
    expect(cycleHasFailure([{ status: 'halted' }])).toBe(true)
  })

  test('reports success for empty or successful cycles', () => {
    expect(cycleHasFailure([])).toBe(false)
    expect(cycleHasFailure([{ status: 'published' }, { status: 'observed' }])).toBe(false)
  })
})

describe('cycleRequiresHalt', () => {
  test('requires a halt only for a halted result', () => {
    expect(cycleRequiresHalt([{ status: 'halted' }])).toBe(true)
    expect(cycleRequiresHalt([{ status: 'published' }, { status: 'halted' }])).toBe(true)
  })

  test('leaves a handled failure retryable on the next interval', () => {
    expect(cycleRequiresHalt([{ status: 'failed' }])).toBe(false)
    expect(cycleRequiresHalt([{ status: 'published' }, { status: 'failed' }])).toBe(false)
    expect(cycleRequiresHalt([])).toBe(false)
  })
})
