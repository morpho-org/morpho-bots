import { afterEach, describe, expect, it, vi } from 'vitest'

import { handler } from '../src/index'

describe('handler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('denies every invocation with the typed fail-closed envelope', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await handler({ kind: 'quote' })

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'SigningNotImplementedError',
        message:
          'no signing surface is implemented in this quoter-signer build; every intent is denied'
      }
    })
  })

  it.each([undefined, null, 'quote', 42, [], { kind: 42 }, { nested: { deep: true } }])(
    'never throws and still denies for adversarial payload %j',
    async payload => {
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const response = await handler(payload)

      expect(response.approved).toBe(false)
      expect(response.denial.name).toBe('SigningNotImplementedError')
    }
  )

  it('emits received and denied JSON lines carrying only the classified kind and request id', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })

    await handler({ kind: 'revoke', evil: 'caller data' }, { awsRequestId: 'req-1' })

    expect(lines.map(line => JSON.parse(line))).toStrictEqual([
      { event: 'middleware.intent_received', intentKind: 'revoke', awsRequestId: 'req-1' },
      {
        event: 'middleware.intent_denied',
        intentKind: 'revoke',
        awsRequestId: 'req-1',
        denial: 'SigningNotImplementedError'
      }
    ])
    for (const line of lines) expect(line).not.toContain('caller data')
  })
})
