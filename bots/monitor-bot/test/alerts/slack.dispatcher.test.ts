import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Alert } from '../../src/alerts/alert'

import { LogAlertDispatcher } from '../../src/alerts/alert'
import { SlackDispatcher } from '../../src/alerts/slack.dispatcher'
import { loadEnv } from '../../src/config/env'
import { buildDispatcher } from '../../src/polling/polling.module'
import { fakeLogger } from '../helpers'

function alert(over: Partial<Alert> = {}): Alert {
  return { key: 'k', title: 'title', text: 'text', severity: 'info', ...over }
}

function slackOk(body: object = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function makeDispatcher(fetchImpl: typeof fetch) {
  return new SlackDispatcher({
    token: 'xoxb-test',
    channel: 'C123',
    logger: fakeLogger(),
    fetchImpl,
    sleep: () => Promise.resolve()
  })
}

describe('SlackDispatcher', () => {
  it('posts one chat.postMessage with channel, mrkdwn text, and auth header', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(slackOk()))
    await makeDispatcher(fetchImpl as unknown as typeof fetch).send([
      alert({
        title: 'big <take>',
        text: '<https://basescan.org/tx/0xabc|big take> by 0x1234…abcd',
        severity: 'critical'
      })
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test')
    const body = JSON.parse(init.body as string) as {
      channel: string
      text: string
      blocks: { text: { text: string } }[]
    }
    expect(body.channel).toBe('C123')
    // `text` is producer-escaped mrkdwn — rendered verbatim (no prefix) so its links survive and
    // the producer's leading emoji stays the first thing in the block.
    expect(body.blocks[0]?.text.text).toBe(
      '<https://basescan.org/tx/0xabc|big take> by 0x1234…abcd'
    )
    // The fallback text field is mrkdwn-parsed too — the plain title must be escaped.
    expect(body.text).toBe('big &lt;take&gt;')
  })

  it('chunks more than 10 alerts into multiple messages', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(slackOk()))
    const alerts = Array.from({ length: 25 }, (_, index) => alert({ key: `k${index}` }))
    await makeDispatcher(fetchImpl as unknown as typeof fetch).send(alerts)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('throws on ok:false so the poller cursor does not advance', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(slackOk({ ok: false, error: 'channel_not_found' }))
    )
    await expect(
      makeDispatcher(fetchImpl as unknown as typeof fetch).send([alert()])
    ).rejects.toThrow('channel_not_found')
  })

  it('retries a 429 with Retry-After before succeeding', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(slackOk())
    await makeDispatcher(fetchImpl as unknown as typeof fetch).send([alert()])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('buildDispatcher', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the log dispatcher when slack is unconfigured', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '')
    const dispatcher = buildDispatcher(loadEnv({}), fakeLogger())
    expect(dispatcher).toBeInstanceOf(LogAlertDispatcher)
  })

  it('returns the slack dispatcher when channel and token are set', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test')
    const dispatcher = buildDispatcher(loadEnv({ SLACK_CHANNEL: 'C123' }), fakeLogger())
    expect(dispatcher).toBeInstanceOf(SlackDispatcher)
  })

  it('fails loud when only one of channel/token is set', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '')
    expect(() => buildDispatcher(loadEnv({ SLACK_CHANNEL: 'C123' }), fakeLogger())).toThrow(
      'SLACK_BOT_TOKEN is required'
    )
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test')
    expect(() => buildDispatcher(loadEnv({}), fakeLogger())).toThrow('SLACK_CHANNEL is required')
  })
})
