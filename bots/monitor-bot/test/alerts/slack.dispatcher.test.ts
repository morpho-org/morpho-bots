import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Alert } from '../../src/alerts/alert'

import { LogAlertDispatcher } from '../../src/alerts/alert'
import { escapeSlack, SlackDispatcher } from '../../src/alerts/slack.dispatcher'
import { loadEnv } from '../../src/config/env'
import { buildDispatcher } from '../../src/polling/polling.module'
import { fakeLogger } from '../helpers'

function alert(over: Partial<Alert> = {}): Alert {
  return { key: 'k', title: 'title', lines: ['line-1'], severity: 'info', ...over }
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

describe('escapeSlack', () => {
  it('escapes the three Slack control characters', () => {
    expect(escapeSlack('<!channel> & <@U1>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt;')
  })
})

describe('SlackDispatcher', () => {
  it('posts one chat.postMessage with channel, escaped content, and auth header', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(slackOk()))
    await makeDispatcher(fetchImpl as unknown as typeof fetch).send([
      alert({ title: 'big <take>', lines: ['maker: <@evil>'], severity: 'critical' })
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test')
    const body = JSON.parse(init.body as string) as {
      channel: string
      blocks: { text: { text: string } }[]
    }
    expect(body.channel).toBe('C123')
    expect(body.blocks[0]?.text.text).toBe('🚨 *big &lt;take&gt;*\nmaker: &lt;@evil&gt;')
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
