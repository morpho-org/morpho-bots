import { describe, expect, it } from 'vitest'

import { escapeSlack, slackLink } from '../../src/alerts/mrkdwn'

describe('escapeSlack', () => {
  it('escapes the three Slack control characters', () => {
    expect(escapeSlack('<!channel> & <@U1>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt;')
  })
})

describe('slackLink', () => {
  it('builds an mrkdwn link with an escaped label, and degrades to plain text without a URL', () => {
    expect(slackLink('https://basescan.org/tx/0xabc', '20M <USDC> lend')).toBe(
      '<https://basescan.org/tx/0xabc|20M &lt;USDC&gt; lend>'
    )
    expect(slackLink(null, '20M <USDC> lend')).toBe('20M &lt;USDC&gt; lend')
  })
})
