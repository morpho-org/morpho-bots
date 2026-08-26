import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KmsPublicKeyMaterial, KmsTransport } from '../src/kms-signer.utils'

import { createHandler, handler } from '../src/index'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address

const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200'
const spkiFor = (secret: `0x${string}`): Uint8Array =>
  hexToBytes(
    `0x${SPKI_PREFIX}${bytesToHex(secp256k1.getPublicKey(hexToBytes(secret), false)).slice(2)}`
  )
const spki = spkiFor(privateKey)

const publicKeyMaterial = (
  overrides: Partial<KmsPublicKeyMaterial> = {}
): KmsPublicKeyMaterial => ({
  publicKey: spki,
  keyArn: 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  keySpec: 'ECC_SECG_P256K1',
  keyUsage: 'SIGN_VERIFY',
  signingAlgorithms: ['ECDSA_SHA_256'],
  ...overrides
})

const fakeKms = (
  getPublicKey: KmsTransport['getPublicKey'] = async () => publicKeyMaterial()
): KmsTransport & { readonly getPublicKey: KmsTransport['getPublicKey'] } => ({
  getPublicKey,
  signDigest: async () => ({})
})

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

const stubKms = () => {
  vi.stubEnv('QUOTER_SIGNER_KMS_KEY_ID', 'alias/quoter-signer-maker')
  vi.stubEnv('QUOTER_SIGNER_KMS_REGION', 'eu-west-1')
}

const notImplementedEnvelope = {
  contractVersion: 1,
  service: 'quoter-signer',
  approved: false,
  denial: {
    name: 'SigningNotImplementedError',
    message:
      'no signing surface is implemented in this quoter-signer build; every intent is denied',
    retryable: false
  }
}

describe('handler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('denies an in-policy intent with kms-not-configured when kms addressing is unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    // Force the unset state so ambient KMS variables in the shell cannot reach the real AWS SDK.
    vi.stubEnv('QUOTER_SIGNER_KMS_KEY_ID', undefined)
    vi.stubEnv('QUOTER_SIGNER_KMS_REGION', undefined)

    const response = await handler(revokeIntent)

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'KmsNotConfiguredError',
        message: 'invalid quoter-signer kms configuration: QUOTER_SIGNER_KMS_KEY_ID missing',
        retryable: false
      }
    })
  })

  it('denies an attested in-policy intent with the typed not-implemented envelope', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())

    const response = await createHandler({ kms: fakeKms(getPublicKey) })(revokeIntent)

    expect(response).toStrictEqual(notImplementedEnvelope)
    expect(getPublicKey).toHaveBeenCalledExactlyOnceWith({
      keyId: 'alias/quoter-signer-maker',
      region: 'eu-west-1'
    })
  })

  it('attests the maker key once per execution environment, not per invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey) })

    const first = await handle(revokeIntent)
    const second = await handle(revokeIntent)

    expect(first).toStrictEqual(notImplementedEnvelope)
    expect(second).toStrictEqual(notImplementedEnvelope)
    expect(getPublicKey).toHaveBeenCalledTimes(1)
  })

  it('denies custody drift with attestation-failed and emits the kms_error line', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    // The configured key answers with another maker's public key: custody drift, fail closed.
    const handle = createHandler({
      kms: fakeKms(async () => publicKeyMaterial({ publicKey: spkiFor(`0x${'22'.repeat(32)}`) }))
    })

    const response = await handle(revokeIntent, { awsRequestId: 'req-3' })

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'KmsAttestationFailedError',
        message: 'quoter-signer kms maker-key attestation failed: maker-mismatch',
        retryable: false
      }
    })
    expect(lines.map(line => JSON.parse(line))).toStrictEqual([
      { event: 'middleware.intent_received', intentKind: 'revoke', awsRequestId: 'req-3' },
      {
        event: 'middleware.kms_error',
        intentKind: 'revoke',
        awsRequestId: 'req-3',
        reason: 'maker-mismatch'
      },
      {
        event: 'middleware.intent_denied',
        intentKind: 'revoke',
        awsRequestId: 'req-3',
        denial: 'KmsAttestationFailedError'
      }
    ])
  })

  it('retries attestation after a kms outage instead of poisoning the container', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    const getPublicKey = vi
      .fn<KmsTransport['getPublicKey']>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey) })

    const outage = await handle(revokeIntent, { awsRequestId: 'req-4' })
    const recovered = await handle(revokeIntent, { awsRequestId: 'req-5' })

    expect(outage).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: {
        name: 'KmsUnavailableError',
        message: 'quoter-signer kms get-public-key call failed',
        retryable: true
      }
    })
    expect(recovered).toStrictEqual(notImplementedEnvelope)
    expect(getPublicKey).toHaveBeenCalledTimes(2)
    expect(lines.map(line => JSON.parse(line))).toContainEqual({
      event: 'middleware.kms_error',
      intentKind: 'revoke',
      awsRequestId: 'req-4',
      operation: 'get-public-key'
    })
  })

  it('re-attests after custody drift so a fixed deployment recovers without a restart', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    // First read shows another maker's key (terminal drift); the operator then fixes the key
    // deployment, so the next invocation on the same warm container must re-attest and pass.
    const getPublicKey = vi
      .fn<KmsTransport['getPublicKey']>()
      .mockResolvedValueOnce(publicKeyMaterial({ publicKey: spkiFor(`0x${'22'.repeat(32)}`) }))
      .mockResolvedValue(publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey) })

    const drifted = await handle(revokeIntent)
    const recovered = await handle(revokeIntent)

    expect(!drifted.approved && drifted.denial.name).toBe('KmsAttestationFailedError')
    expect(recovered).toStrictEqual(notImplementedEnvelope)
    expect(getPublicKey).toHaveBeenCalledTimes(2)
  })

  it('never calls kms for malformed or out-of-policy intents', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy({ surface: 'quote' })
    stubKms()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey) })

    await handle({ kind: 'quote' })
    await handle(revokeIntent)

    expect(getPublicKey).not.toHaveBeenCalled()
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
