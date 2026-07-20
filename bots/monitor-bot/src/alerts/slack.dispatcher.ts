import type { Logger } from '@repo/bot-kit'

import { delay, ensureError, fetchWithRetry, parseJsonResponse } from '@repo/utils'
import chunk from 'lodash-es/chunk'

import type { Alert, AlertDispatcher } from './alert'

const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'

/** Alerts per Slack message — stays well under Slack's 50-blocks-per-message limit. */
const ALERTS_PER_MESSAGE = 10

const SEVERITY_EMOJI = { info: 'ℹ️', warning: '⚠️', critical: '🚨' } as const

// Slack interprets &, < and > as control sequences (<!channel>, <@id> mentions) — escape every
// API-sourced string so alert content can never inject a mention or link.
export function escapeSlack(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function alertBlock(alert: Alert) {
  const title = `${SEVERITY_EMOJI[alert.severity]} *${escapeSlack(alert.title)}*`
  const body = alert.lines.map(line => escapeSlack(line)).join('\n')
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: body ? `${title}\n${body}` : title }
  }
}

type SlackDispatcherDependencies = {
  token: string
  channel: string
  logger: Logger
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

// Posts alerts to the configured channel via chat.postMessage (bot token — the channel is
// env-configured, unlike webhooks which pin it at webhook-creation time). Slack IS the delivery
// product here, so failures log AND throw: the poller pipeline then keeps its cursor and re-sends
// the same window next tick (at-least-once).
export class SlackDispatcher implements AlertDispatcher {
  constructor(private readonly deps: SlackDispatcherDependencies) {}

  async send(alerts: Alert[]) {
    for (const batch of chunk(alerts, ALERTS_PER_MESSAGE)) {
      await this.postToSlack(batch)
    }
    this.deps.logger.info('slack.sent', { alerts: alerts.length })
  }

  private async postToSlack(alerts: Alert[]) {
    const body = await fetchWithRetry(() => this.request(alerts), {
      label: 'slack.postMessage',
      sleep: this.deps.sleep ?? delay
    }).catch(error => {
      this.deps.logger.error('slack.error', { error: ensureError(error).message })
      throw error
    })
    // Slack signals application errors with HTTP 200 + ok:false (invalid_auth, channel_not_found…).
    if (!body.ok) {
      this.deps.logger.error('slack.error', { error: body.error ?? 'unknown' })
      throw new Error(`slack.postMessage failed: ${body.error ?? 'unknown'}`)
    }
  }

  private async request(alerts: Alert[]) {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const response = await fetchImpl(POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.deps.token}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        channel: this.deps.channel,
        text: alerts.map(alert => alert.title).join(' | '),
        blocks: alerts.map(alertBlock)
      }),
      signal: AbortSignal.timeout(10_000)
    })
    // Parse leniently: a throw inside this callback would read as a retryable network error to
    // fetchWithRetry, so a 5xx HTML body must not explode here — status handling comes first.
    const parsed = await parseJsonResponse<{ ok: boolean; error?: string }>(response)
    return { data: parsed.data ?? undefined, response }
  }
}
