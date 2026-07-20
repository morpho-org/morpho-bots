import { describe, expect, it } from 'vitest'

import { LifecycleNotifier } from '../../src/alerts/lifecycle.notifier'
import { capturingDispatcher, fakeLogger } from '../helpers'

describe('LifecycleNotifier', () => {
  it('dispatches a startup alert on bootstrap', async () => {
    const dispatcher = capturingDispatcher()
    const notifier = new LifecycleNotifier(dispatcher, fakeLogger())
    await notifier.onApplicationBootstrap()
    expect(dispatcher.sent).toHaveLength(1)
    const alert = dispatcher.sent[0]?.[0]
    expect(alert?.key).toBe('lifecycle:startup')
    expect(alert?.severity).toBe('info')
    expect(alert?.text).toContain('monitor-bot started')
  })

  it('dispatches a shutdown alert carrying the signal', async () => {
    const dispatcher = capturingDispatcher()
    const notifier = new LifecycleNotifier(dispatcher, fakeLogger())
    await notifier.beforeApplicationShutdown('SIGTERM')
    const alert = dispatcher.sent[0]?.[0]
    expect(alert?.key).toBe('lifecycle:shutdown')
    expect(alert?.text).toContain('shutting down (SIGTERM)')
  })

  it('omits the signal suffix when shutdown has no signal', async () => {
    const dispatcher = capturingDispatcher()
    const notifier = new LifecycleNotifier(dispatcher, fakeLogger())
    await notifier.beforeApplicationShutdown()
    const alert = dispatcher.sent[0]?.[0]
    expect(alert?.text).toContain('shutting down')
    expect(alert?.text).not.toContain('(')
  })

  it('logs instead of throwing when dispatch fails', async () => {
    const dispatcher = capturingDispatcher()
    const logger = fakeLogger()
    const notifier = new LifecycleNotifier(dispatcher, logger)
    dispatcher.failNext()
    await expect(notifier.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith('lifecycle.alert_failed', {
      event: 'startup',
      error: 'dispatch failed'
    })
  })
})
