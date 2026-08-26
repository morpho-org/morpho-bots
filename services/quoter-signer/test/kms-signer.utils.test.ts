import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hashMessage, hexToBigInt, hexToBytes, recoverAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { KmsAttestationReason } from '../src/kms-attestation-failed.error'
import type { KmsPublicKeyMaterial, KmsTransport } from '../src/kms-signer.utils'
import type { KmsSigningFailureReason } from '../src/kms-signing-failed.error'
import type { KmsOperation } from '../src/kms-unavailable.error'

import { KmsAttestationFailedError } from '../src/kms-attestation-failed.error'
import { awsKmsTransport, createKmsMakerSigner } from '../src/kms-signer.utils'
import { KmsSigningFailedError } from '../src/kms-signing-failed.error'

// The default transport is exercised against a mocked AWS SDK so the exact command shapes
// (DIGEST message type, ECDSA_SHA_256, KeyId passthrough) and the per-region client reuse are
// proven without AWS. Every other test injects a plain fake transport and never touches the mock.
const { sendMock, clientConfigs } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  clientConfigs: [] as unknown[]
}))

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class {
    constructor(configuration: unknown) {
      clientConfigs.push(configuration)
    }
    send = sendMock
  },
  GetPublicKeyCommand: class {
    constructor(readonly input: unknown) {}
  },
  SignCommand: class {
    constructor(readonly input: unknown) {}
  }
}))

const privateKey = `0x${'11'.repeat(32)}` as const
const secret = hexToBytes(privateKey)
const publicKey = secp256k1.getPublicKey(secret, false)
const maker = privateKeyToAccount(privateKey).address
const otherMaker = privateKeyToAccount(`0x${'22'.repeat(32)}`).address

const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200'
const spki = hexToBytes(`0x${SPKI_PREFIX}${bytesToHex(publicKey).slice(2)}`)

const config = { keyId: 'alias/quoter-signer-maker', region: 'eu-west-1' }
const digest = hashMessage('quoter-signer kms signing increment')

const HALF_ORDER = secp256k1.CURVE.n / 2n

const publicKeyMaterial = (
  overrides: Partial<KmsPublicKeyMaterial> = {}
): KmsPublicKeyMaterial => ({
  publicKey: spki,
  keySpec: 'ECC_SECG_P256K1',
  keyUsage: 'SIGN_VERIFY',
  signingAlgorithms: ['ECDSA_SHA_256', 'ECDSA_SHA_384'],
  ...overrides
})

const fakeTransport = (overrides: Partial<KmsTransport> = {}): KmsTransport => ({
  getPublicKey: async () => publicKeyMaterial(),
  signDigest: async (_config, digestBytes) => ({
    signature: secp256k1.sign(digestBytes, secret, { lowS: false }).toDERRawBytes(),
    kmsRequestId: 'kms-request-1'
  }),
  ...overrides
})

const expectAttestationFailure = async (
  attempt: Promise<unknown>,
  reason: KmsAttestationReason
) => {
  await expect(attempt).rejects.toMatchObject({
    name: 'KmsAttestationFailedError',
    reason,
    retryable: false
  })
}

const expectSigningFailure = async (attempt: Promise<unknown>, reason: KmsSigningFailureReason) => {
  await expect(attempt).rejects.toMatchObject({
    name: 'KmsSigningFailedError',
    reason,
    retryable: false
  })
}

const expectUnavailable = async (attempt: Promise<unknown>, operation: KmsOperation) => {
  await expect(attempt).rejects.toMatchObject({
    name: 'KmsUnavailableError',
    operation,
    retryable: true
  })
}

describe('createKmsMakerSigner', () => {
  it('attests the configured maker and signs recoverable low-s signatures', async () => {
    const signer = await createKmsMakerSigner(config, maker, fakeTransport())

    expect(signer.address).toBe(maker)
    expect(signer.publicKey).toBe(bytesToHex(publicKey))

    const signed = await signer.signDigest(digest)

    expect(await recoverAddress({ hash: digest, signature: signed.signature })).toBe(maker)
    expect(hexToBigInt(`0x${signed.signature.slice(66, 130)}`)).toBeLessThanOrEqual(HALF_ORDER)
    expect(signed.kmsRequestId).toBe('kms-request-1')
  })

  it('normalizes a high-s KMS signature before recovery', async () => {
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        signDigest: async (_config, digestBytes) => {
          const signature = secp256k1.sign(digestBytes, secret, { lowS: true })
          return {
            signature: new secp256k1.Signature(
              signature.r,
              secp256k1.CURVE.n - signature.s
            ).toDERRawBytes(),
            kmsRequestId: 'kms-request-2'
          }
        }
      })
    )

    const signed = await signer.signDigest(digest)

    expect(await recoverAddress({ hash: digest, signature: signed.signature })).toBe(maker)
    expect(hexToBigInt(`0x${signed.signature.slice(66, 130)}`)).toBeLessThanOrEqual(HALF_ORDER)
    expect(signed.kmsRequestId).toBe('kms-request-2')
  })

  it('passes the deployment config, never caller data, to the transport', async () => {
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const signDigest = vi.fn(async (_config: typeof config, digestBytes: Uint8Array) => ({
      signature: secp256k1.sign(digestBytes, secret, { lowS: false }).toDERRawBytes(),
      kmsRequestId: 'kms-request-1'
    }))
    const signer = await createKmsMakerSigner(config, maker, { getPublicKey, signDigest })

    await signer.signDigest(digest)

    expect(getPublicKey).toHaveBeenCalledExactlyOnceWith(config)
    expect(signDigest).toHaveBeenCalledExactlyOnceWith(config, hexToBytes(digest))
  })

  it('wraps a failed GetPublicKey call into a retryable unavailability', async () => {
    const cause = new Error('socket hang up')
    const attempt = createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        getPublicKey: async () => {
          throw cause
        }
      })
    )

    await expectUnavailable(attempt, 'get-public-key')
    await expect(attempt).rejects.toMatchObject({ cause })
  })

  it.each<[string, Partial<KmsPublicKeyMaterial>]>([
    ['a wrong key spec', { keySpec: 'ECC_NIST_P256' }],
    ['a wrong key usage', { keyUsage: 'ENCRYPT_DECRYPT' }],
    ['missing signing algorithms', { signingAlgorithms: undefined }],
    ['signing algorithms without ECDSA_SHA_256', { signingAlgorithms: ['ECDSA_SHA_384'] }]
  ])('rejects a key with %s', async (_name, overrides) => {
    await expectAttestationFailure(
      createKmsMakerSigner(
        config,
        maker,
        fakeTransport({ getPublicKey: async () => publicKeyMaterial(overrides) })
      ),
      'key-spec'
    )
  })

  it('rejects a GetPublicKey response without key material', async () => {
    await expectAttestationFailure(
      createKmsMakerSigner(
        config,
        maker,
        fakeTransport({ getPublicKey: async () => publicKeyMaterial({ publicKey: undefined }) })
      ),
      'missing-public-key'
    )
  })

  it.each([
    ['truncated SPKI', `${SPKI_PREFIX}04`],
    [
      'BER indefinite-length SPKI',
      `3080301006072a8648ce3d020106052b8104000a034200${bytesToHex(publicKey).slice(2)}0000`
    ],
    [
      'wrong P-256 curve',
      `3059301306072a8648ce3d020106082a8648ce3d030107034200${bytesToHex(publicKey).slice(2)}`
    ],
    ['trailing data', `${SPKI_PREFIX}${bytesToHex(publicKey).slice(2)}00`],
    [
      'trailing SPKI field',
      `3058301006072a8648ce3d020106052b8104000a034200${bytesToHex(publicKey).slice(2)}0500`
    ],
    [
      'compressed point',
      `3036301006072a8648ce3d020106052b8104000a032200${bytesToHex(secp256k1.getPublicKey(secret, true)).slice(2)}`
    ],
    ['off-curve point', `${SPKI_PREFIX}04${'00'.repeat(64)}`],
    ['empty SPKI', '']
  ])('rejects malformed or unsupported SPKI: %s', async (_name, spkiHex) => {
    await expectAttestationFailure(
      createKmsMakerSigner(
        config,
        maker,
        fakeTransport({
          getPublicKey: async () => publicKeyMaterial({ publicKey: hexToBytes(`0x${spkiHex}`) })
        })
      ),
      'public-key-encoding'
    )
  })

  it('rejects an on-curve key that does not derive the policy-pinned maker', async () => {
    await expectAttestationFailure(
      createKmsMakerSigner(config, otherMaker, fakeTransport()),
      'maker-mismatch'
    )
  })

  it('rejects a non-32-byte digest before any KMS call', async () => {
    const signDigest = vi.fn()
    const signer = await createKmsMakerSigner(config, maker, fakeTransport({ signDigest }))

    await expectSigningFailure(signer.signDigest('0x1234'), 'digest-width')
    expect(signDigest).not.toHaveBeenCalled()
  })

  it('wraps a failed Sign call into a retryable unavailability', async () => {
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        signDigest: async () => {
          throw new Error('throttled')
        }
      })
    )

    await expectUnavailable(signer.signDigest(digest), 'sign')
  })

  it('rejects a Sign response without signature bytes', async () => {
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({ signDigest: async () => ({}) })
    )

    await expectSigningFailure(signer.signDigest(digest), 'missing-signature')
  })

  it('rejects a Sign response without the CloudTrail request id', async () => {
    // A valid signature without its reconciliation join key would be an unreconcilable record.
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        signDigest: async (_config, digestBytes) => ({
          signature: secp256k1.sign(digestBytes, secret, { lowS: false }).toDERRawBytes()
        })
      })
    )

    await expectSigningFailure(signer.signDigest(digest), 'missing-request-id')
  })

  it.each([
    ['wrong sequence tag', '3106020101020101'],
    ['wrong sequence length', '3007020101020101'],
    ['wrong r tag', '3006030101020101'],
    ['wrong s tag', '3006020101030101'],
    ['empty r', '30050200020101'],
    ['empty s', '30050201010200'],
    ['oversized r', `30250222${'01'.repeat(34)}020101`],
    ['33-byte r without sign padding', `30250221${'01'.repeat(33)}020101`],
    ['truncated r', '300402030102'],
    ['trailing bytes', '300702010102010100'],
    ['zero r', '3006020100020101'],
    ['zero s', '3006020101020100'],
    ['negative r', '3006020180020101'],
    ['negative s', '3006020101020180'],
    ['redundant r padding', '300702020001020101'],
    ['redundant s padding', '300702010102020001'],
    [
      'r at curve order',
      '3026022100fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141020101'
    ],
    [
      's at curve order',
      '3026020101022100fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
    ]
  ])('rejects malformed or non-canonical DER: %s', async (_name, derHex) => {
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        signDigest: async () => ({
          signature: hexToBytes(`0x${derHex}`),
          kmsRequestId: 'kms-request-1'
        })
      })
    )

    await expectSigningFailure(signer.signDigest(digest), 'der-encoding')
  })

  it('rejects a canonical signature recovering to neither parity', async () => {
    // r = s = 1 parses as canonical DER but cannot recover the attested maker.
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        signDigest: async () => ({
          signature: hexToBytes('0x3006020101020101'),
          kmsRequestId: 'kms-request-1'
        })
      })
    )

    await expectSigningFailure(signer.signDigest(digest), 'recovery')
  })

  it('rejects a valid signature produced by another key', async () => {
    const signer = await createKmsMakerSigner(
      config,
      maker,
      fakeTransport({
        signDigest: async (_config, digestBytes) => ({
          signature: secp256k1
            .sign(digestBytes, hexToBytes(`0x${'22'.repeat(32)}`), { lowS: false })
            .toDERRawBytes(),
          kmsRequestId: 'kms-request-1'
        })
      })
    )

    await expectSigningFailure(signer.signDigest(digest), 'recovery')
  })

  it('exposes only the attestation and digest surfaces, never a generic account', async () => {
    const signer = await createKmsMakerSigner(config, maker, fakeTransport())

    expect(Object.keys(signer).toSorted()).toStrictEqual(['address', 'publicKey', 'signDigest'])
  })
})

describe('awsKmsTransport', () => {
  beforeEach(() => {
    sendMock.mockReset()
  })

  it('maps GetPublicKey and pins the DIGEST/ECDSA_SHA_256 Sign shape on one client', async () => {
    const der = secp256k1.sign(hexToBytes(digest), secret, { lowS: false }).toDERRawBytes()
    sendMock
      .mockResolvedValueOnce({
        PublicKey: spki,
        KeySpec: 'ECC_SECG_P256K1',
        KeyUsage: 'SIGN_VERIFY',
        SigningAlgorithms: ['ECDSA_SHA_256']
      })
      .mockResolvedValueOnce({ Signature: der, $metadata: { requestId: 'aws-request-9' } })
    const transportConfig = { keyId: 'alias/transport-maker', region: 'us-east-1' }

    const material = await awsKmsTransport.getPublicKey(transportConfig)
    const signed = await awsKmsTransport.signDigest(transportConfig, hexToBytes(digest))

    expect(material).toStrictEqual({
      publicKey: spki,
      keySpec: 'ECC_SECG_P256K1',
      keyUsage: 'SIGN_VERIFY',
      signingAlgorithms: ['ECDSA_SHA_256']
    })
    expect(signed).toStrictEqual({ signature: der, kmsRequestId: 'aws-request-9' })
    const commands = sendMock.mock.calls.map(call => (call[0] as { input: unknown }).input)
    expect(commands).toStrictEqual([
      { KeyId: 'alias/transport-maker' },
      {
        KeyId: 'alias/transport-maker',
        Message: hexToBytes(digest),
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256'
      }
    ])
    expect(
      clientConfigs.filter(entry => (entry as { region?: string }).region === 'us-east-1')
    ).toHaveLength(1)
  })

  it('signs through the default transport end to end', async () => {
    sendMock.mockImplementation(async (command: { readonly input: Record<string, unknown> }) =>
      'Message' in command.input
        ? {
            Signature: secp256k1
              .sign(command.input.Message as Uint8Array, secret, { lowS: false })
              .toDERRawBytes(),
            $metadata: { requestId: 'aws-request-e2e' }
          }
        : {
            PublicKey: spki,
            KeySpec: 'ECC_SECG_P256K1',
            KeyUsage: 'SIGN_VERIFY',
            SigningAlgorithms: ['ECDSA_SHA_256']
          }
    )

    const signer = await createKmsMakerSigner(
      { keyId: 'alias/default-transport-maker', region: 'eu-central-1' },
      maker
    )
    const signed = await signer.signDigest(digest)

    expect(await recoverAddress({ hash: digest, signature: signed.signature })).toBe(maker)
    expect(signed.kmsRequestId).toBe('aws-request-e2e')
  })
})

describe('error surfaces', () => {
  it('keeps attestation and signing failures typed and sanitized', () => {
    const attestation = new KmsAttestationFailedError('maker-mismatch')
    const signing = new KmsSigningFailedError('recovery')

    expect(attestation.message).toBe(
      'quoter-signer kms maker-key attestation failed: maker-mismatch'
    )
    expect(signing.message).toBe('quoter-signer kms signature rejected: recovery')
  })
})
