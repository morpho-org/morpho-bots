import { afterEach, describe, expect, it, vi } from 'vitest'

import { handler } from '../src/index'

const revokeIntent = {
  contractVersion: 1,
  kind: 'revoke',
  chainId: 8453,
  maker: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  idempotencyKey: 'revoke-1',
  operation: { type: 'cancel-root', root: `0x${'77'.repeat(32)}` },
  fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', gas: '90000' }
}

describe('handler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('denies a well-formed intent with the typed not-implemented envelope', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await handler(revokeIntent)

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'SigningNotImplementedError',
        message:
          'no signing surface is implemented in this quoter-signer build; every intent is denied',
        retryable: false
      }
    })
  })

  it('denies a contract-violating payload with the typed malformed-intent envelope', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await handler({ kind: 'quote' })

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'MalformedIntentError',
        message: 'invalid quoter-signer intent: contractVersion missing',
        retryable: false
      }
    })
  })

  it.each([undefined, null, 'quote', 42, [], { kind: 42 }, { nested: { deep: true } }])(
    'never throws and still denies for adversarial payload %j',
    async payload => {
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const response = await handler(payload)

      expect(response.approved).toBe(false)
      expect(!response.approved && response.denial.name).toBe('MalformedIntentError')
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
        denial: 'MalformedIntentError'
      }
    ])
    for (const line of lines) expect(line).not.toContain('caller data')
  })
})
