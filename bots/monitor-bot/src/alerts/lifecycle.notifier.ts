import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common'
import type { Logger } from '@repo/bot-kit'

import { Inject, Injectable } from '@nestjs/common'
import { ensureError } from '@repo/utils'

import type { Alert, AlertDispatcher } from './alert'

import { LOGGER } from '../logging/logger.provider'
import { ALERT_DISPATCHER } from './alert'

// Lifecycle breadcrumbs through the regular alert pipeline: posted to Slack when it is configured,
// log-only otherwise. Delivery is best-effort — unlike poller alerts (at-least-once via cursor
// replay) there is no state to retry from, and a Slack outage must never fail a boot or wedge a
// shutdown, so a failed send only logs.
@Injectable()
export class LifecycleNotifier implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(ALERT_DISPATCHER) private readonly dispatcher: AlertDispatcher,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async onApplicationBootstrap() {
    await this.notify('startup', ':large_green_circle: monitor-bot started')
  }

  // beforeApplicationShutdown, not onApplicationShutdown: it carries the signal name and runs
  // before the registrar's hook awaits in-flight ticks, so the message posts while shutdown is
  // still fresh rather than after the last tick drains.
  async beforeApplicationShutdown(signal?: string) {
    const reason = signal ? ` (${signal})` : ''
    await this.notify('shutdown', `:red_circle: monitor-bot shutting down${reason}`)
  }

  private async notify(event: 'startup' | 'shutdown', message: string) {
    // Static producer-owned copy — nothing API-sourced, so no mrkdwn escaping is needed.
    const alert: Alert = {
      key: `lifecycle:${event}`,
      title: message,
      text: message,
      severity: 'info'
    }
    await this.dispatcher.send([alert]).catch(error => {
      this.logger.error('lifecycle.alert_failed', { event, error: ensureError(error).message })
    })
  }
}
