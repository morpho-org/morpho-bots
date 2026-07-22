import type { Logger } from '@repo/bot-kit'

import { Inject, Injectable } from '@nestjs/common'

import { LOGGER } from '../logging/logger.provider'

export type Alert = {
  /** Stable idempotency key for downstream dedupe (e.g. the API's stable activity id). */
  key: string
  /** The alert as one plain-text sentence — Slack's notification fallback and the log line. */
  title: string
  /**
   * The same sentence as Slack mrkdwn with explorer links. Producers escape every interpolated
   * API-sourced string via the `alerts/mrkdwn` helpers; dispatchers render this verbatim (escaping
   * here would destroy the `<url|label>` links).
   */
  text: string
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
        severity: alert.severity
      })
    }
    return Promise.resolve()
  }
}
