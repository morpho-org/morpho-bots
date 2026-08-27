import { afterEach, describe, expect, it, vi } from 'vitest'

import { handler } from '../src/index'

const maker = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'

const revokeIntent = {
  contractVersion: 1,
  kind: 'revoke',
  chainId: 8453,
  maker,
  idempotencyKey: 'revoke-1',
  operation: { type: 'cancel-root', root: `0x${'77'.repeat(32)}` },
  fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', gas: '90000' }
}

const routineCeiling = {
  maxFeePerGas: '3000000000',
  maxPriorityFeePerGas: '1500000000',
  gas: '400000'
}

const policyDocument = (overrides: Record<string, unknown> = {}) => ({
  policyVersion: 1,
  surface: 'routine-revoke',
  ratifierMode: 'ecrecover',
  chainId: 8453,
  maker,
  ratifier: '0x4444444444444444444444444444444444444444',
  offerWindow: { freshnessCeilingSeconds: '3600', maxStartAgeSeconds: '900' },
  markets: [
    {
      marketId: `0x${'55'.repeat(32)}`,
      maturity: '1800000000',
      minTick: '100',
      maxTick: '5000',
      maxContinuousFeeCap: '317097919',
      maxLendExposureAssets: '20000000000'
    }
  ],
  maxTotalLendExposureAssets: '30000000000',
  feeCeilings: {
    routine: routineCeiling,
    protected: { maxFeePerGas: '30000000000', maxPriorityFeePerGas: '15000000000', gas: '800000' }
  },
  remediations: [],
  ...overrides
})

const stubPolicy = (overrides: Record<string, unknown> = {}) => {
  vi.stubEnv('QUOTER_SIGNER_POLICY', JSON.stringify(policyDocument(overrides)))
}

describe('handler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('denies a well-formed in-policy intent with the typed not-implemented envelope', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()

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

  it('denies every well-formed intent when the deployment policy is missing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Force the unset state so an ambient QUOTER_SIGNER_POLICY in the shell cannot flip the test.
    vi.stubEnv('QUOTER_SIGNER_POLICY', undefined)

    const response = await handler(revokeIntent)

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'PolicyNotConfiguredError',
        message: 'invalid quoter-signer policy: QUOTER_SIGNER_POLICY missing',
        retryable: false
      }
    })
  })

  it('refuses to serve on an invalid deployment policy without echoing its content', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('QUOTER_SIGNER_POLICY', '{not json')

    const response = await handler(revokeIntent)

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'PolicyNotConfiguredError',
      message: 'invalid quoter-signer policy: QUOTER_SIGNER_POLICY not-json',
      retryable: false
    })
  })

  it('denies an out-of-policy intent with the violated check in envelope and log', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'quote' })

    const response = await handler(revokeIntent, { awsRequestId: 'req-2' })

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'IntentPolicyViolationError',
        message: 'quoter-signer policy denied intent: kind failed surface-intent-kind',
        retryable: false
      }
    })
    expect(lines.map(line => JSON.parse(line))).toStrictEqual([
      { event: 'middleware.intent_received', intentKind: 'revoke', awsRequestId: 'req-2' },
      {
        event: 'middleware.intent_denied',
        intentKind: 'revoke',
        awsRequestId: 'req-2',
        denial: 'IntentPolicyViolationError',
        check: 'surface-intent-kind',
        field: 'kind'
      }
    ])
  })

  it('fails closed on an unexpected evaluation fault', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock fault')
    })

    const response = await handler(revokeIntent)

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'IntentPolicyViolationError',
      message: 'quoter-signer policy denied intent: intent failed internal-fault',
      retryable: false
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
