import type { Logger } from '@repo/bot-kit'

import { Inject, Injectable } from '@nestjs/common'

import { LOGGER } from '../logging/logger.provider'

export type Alert = {
  /** Stable idempotency key for downstream dedupe (e.g. the API's stable activity id). */
  key: string
  title: string
  lines: string[]
  severity: 'info' | 'warning' | 'critical'
}

export const ALERT_DISPATCHER = Symbol('ALERT_DISPATCHER')

export interface AlertDispatcher {
  send(alerts: Alert[]): Promise<void>
}

// Default dispatcher until the Slack dispatcher lands: every alert becomes one structured log
// line, so poller output is observable end-to-end before any Slack wiring exists.
@Injectable()
export class LogAlertDispatcher implements AlertDispatcher {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  send(alerts: Alert[]) {
    for (const alert of alerts) {
      this.logger.info('alert', {
        key: alert.key,
        title: alert.title,
        severity: alert.severity,
        lines: alert.lines
      })
    }
    return Promise.resolve()
  }
}
