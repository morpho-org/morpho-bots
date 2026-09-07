import type { TransactionSerializedEIP1559 } from 'viem'

import {
  EcrecoverRatifierUtils,
  Group,
  Offer,
  Payload,
  setterRatifierAbi,
  Tree
} from '@morpho-org/midnight-sdk'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  bytesToHex,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBytes,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChainReadTransport } from '../src/chain-read.utils'
import type { KmsPublicKeyMaterial, KmsTransport } from '../src/kms-signer.utils'

import { createHandler, handler } from '../src/index'
import { KMS_ATTESTATION_FRESHNESS_MS } from '../src/kms-signer.utils'
import {
  FIXTURE_LOAN_TOKEN,
  FIXTURE_MEMPOOL,
  FIXTURE_MIDNIGHT,
  FIXTURE_RATIFIER,
  FIXTURE_ZERO_ADDRESS,
  fixtureCollateral,
  fixtureMarketEntry,
  fixtureMarketId,
  fixtureMaturityAfter,
  fixturePolicyDocument,
  fixtureRemediationAction
} from './policy-fixture'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address
const secret = hexToBytes(privateKey)

const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200'
const spkiFor = (key: `0x${string}`): Uint8Array =>
  hexToBytes(
    `0x${SPKI_PREFIX}${bytesToHex(secp256k1.getPublicKey(hexToBytes(key), false)).slice(2)}`
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

/** Fake KMS transport producing genuine DER secp256k1 signatures with the maker key. */
const fakeKms = (
  getPublicKey: KmsTransport['getPublicKey'] = async () => publicKeyMaterial(),
  signDigest: KmsTransport['signDigest'] = async (_config, digestBytes) => ({
    signature: secp256k1.sign(digestBytes, secret, { lowS: false }).toDERRawBytes(),
    kmsRequestId: 'kms-req-sign'
  })
): KmsTransport => ({ getPublicKey, signDigest })

const chainReadFake = (overrides: Partial<ChainReadTransport> = {}): ChainReadTransport => ({
  chainId: async () => 8453,
  pendingNonce: async () => 7,
  latestNonce: async () => 5,
  allowance: async () => 0n,
  ...overrides
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

const remediationIntent = {
  contractVersion: 1,
  kind: 'setup-remediation',
  chainId: 8453,
  maker,
  idempotencyKey: 'remediation-1',
  remediation: 'loan-asset-approval',
  fees: revokeIntent.fees
}

const policyDocument = (overrides: Record<string, unknown> = {}) => fixturePolicyDocument(overrides)

const stubPolicy = (overrides: Record<string, unknown> = {}) => {
  vi.stubEnv('QUOTER_SIGNER_POLICY', JSON.stringify(policyDocument(overrides)))
}

const stubKms = () => {
  vi.stubEnv('QUOTER_SIGNER_KMS_KEY_ID', 'alias/quoter-signer-maker')
  vi.stubEnv('QUOTER_SIGNER_KMS_REGION', 'eu-west-1')
}

const stubRpc = () => {
  vi.stubEnv('QUOTER_SIGNER_RPC_URL', 'https://rpc.example')
}

/** Offer-set fixture relative to the real middleware clock, coherent for quote and ratify. */
const buildOfferFixture = () => {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const maturity = fixtureMaturityAfter(now)
  const marketId = fixtureMarketId({ maturity })
  const start = (now - 60n).toString()
  const expiry = (now + 1800n).toString()
  const marketStruct = {
    chainId: 8453n,
    midnight: FIXTURE_MIDNIGHT,
    loanToken: FIXTURE_LOAN_TOKEN,
    collateralParams: [
      {
        token: fixtureCollateral.token,
        lltv: BigInt(fixtureCollateral.lltv),
        liquidationCursor: BigInt(fixtureCollateral.liquidationCursor),
        oracle: fixtureCollateral.oracle
      }
    ],
    maturity: BigInt(maturity),
    rcfThreshold: 0n,
    enterGate: FIXTURE_ZERO_ADDRESS,
    liquidatorGate: FIXTURE_ZERO_ADDRESS
  } as const
  const sdkOffer = Offer.create({
    market: marketStruct,
    buy: true,
    maker,
    start: BigInt(start),
    expiry: BigInt(expiry),
    tick: 120n,
    callback: FIXTURE_ZERO_ADDRESS,
    callbackData: '0x',
    receiverIfMakerIsSeller: FIXTURE_ZERO_ADDRESS,
    ratifier: FIXTURE_RATIFIER,
    reduceOnly: false,
    maxUnits: 0n,
    maxAssets: 1000000n,
    continuousFeeCap: 317097919n
  })
  const tree = Tree.create([Group.create([sdkOffer])])
  const offers = [
    {
      marketId,
      buy: true,
      start,
      expiry,
      tick: '120',
      group: sdkOffer.group,
      callback: FIXTURE_ZERO_ADDRESS,
      callbackData: '0x',
      receiverIfMakerIsSeller: FIXTURE_ZERO_ADDRESS,
      ratifier: FIXTURE_RATIFIER,
      reduceOnly: false,
      maxUnits: '0',
      maxAssets: '1000000',
      continuousFeeCap: '317097919'
    }
  ]
  return { maturity, offers, tree }
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

  it('approves an in-policy revoke with a signed cancel-root artifact and audit lines', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    stubRpc()
    const handle = createHandler({ kms: fakeKms(), chainRead: chainReadFake() })

    const response = await handle(revokeIntent, { awsRequestId: 'req-a' })

    expect(response.approved).toBe(true)
    if (!response.approved) throw new Error('unreachable')
    expect(response.result.kind).toBe('revoke')
    if (response.result.kind !== 'revoke') throw new Error('unreachable')
    const artifact = response.result.transaction
    expect(artifact.nonce).toBe(7)
    expect(artifact.fees).toStrictEqual(revokeIntent.fees)
    await expect(
      recoverTransactionAddress({
        serializedTransaction: artifact.signedTransaction as TransactionSerializedEIP1559
      })
    ).resolves.toBe(maker)
    const parsed = parseTransaction(artifact.signedTransaction)
    expect(getAddress(parsed.to!)).toBe(FIXTURE_RATIFIER)
    expect(parsed.chainId).toBe(8453)
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toStrictEqual([
      { event: 'middleware.intent_received', intentKind: 'revoke', awsRequestId: 'req-a' },
      {
        event: 'middleware.kms_sign',
        intentKind: 'revoke',
        awsRequestId: 'req-a',
        digest: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        kmsRequestId: 'kms-req-sign'
      },
      {
        event: 'middleware.intent_approved',
        intentKind: 'revoke',
        awsRequestId: 'req-a',
        operation: 'cancel-root',
        nonce: 7,
        transactionHash: artifact.hash,
        kmsSignCalls: 1
      }
    ])
  })

  it('approves a consume-groups batch as one signed singleton multicall', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    stubRpc()
    const handle = createHandler({ kms: fakeKms(), chainRead: chainReadFake() })

    const response = await handle({
      ...revokeIntent,
      operation: {
        type: 'consume-groups',
        groups: [`0x${'66'.repeat(32)}`, `0x${'67'.repeat(32)}`]
      }
    })

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'revoke') throw new Error('unreachable')
    const parsed = parseTransaction(response.result.transaction.signedTransaction)
    expect(getAddress(parsed.to!)).toBe(FIXTURE_MIDNIGHT)
  })

  it('approves a break-glass replacement at an explicit occupied nonce under protected fees', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy({ surface: 'break-glass-revoke' })
    stubKms()
    stubRpc()
    const latestNonce = vi.fn(async () => 5)
    const handle = createHandler({
      kms: fakeKms(),
      chainRead: chainReadFake({ latestNonce }),
      attestAtStartup: false
    })
    // Emergency-window fees: above the routine ceilings, inside the protected ones.
    const fees = { maxFeePerGas: '5000000000', maxPriorityFeePerGas: '2000000000', gas: '500000' }

    const response = await handle({
      ...revokeIntent,
      operation: { type: 'consume-groups', groups: [`0x${'66'.repeat(32)}`], nonce: 5 },
      fees
    })

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'revoke') throw new Error('unreachable')
    const artifact = response.result.transaction
    expect(artifact.nonce).toBe(5)
    expect(latestNonce).toHaveBeenCalledOnce()
    const parsed = parseTransaction(artifact.signedTransaction)
    expect(getAddress(parsed.to!)).toBe(FIXTURE_MIDNIGHT)
    await expect(
      recoverTransactionAddress({
        serializedTransaction: artifact.signedTransaction as TransactionSerializedEIP1559
      })
    ).resolves.toBe(maker)
  })

  it('denies a break-glass operation without an explicit placement nonce, with no reads', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'break-glass-revoke' })
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const chainId = vi.fn(async () => 8453)
    const pendingNonce = vi.fn(async () => 7)
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake({ chainId, pendingNonce }),
      attestAtStartup: false
    })
    const fees = { maxFeePerGas: '5000000000', maxPriorityFeePerGas: '2000000000', gas: '500000' }

    const response = await handle({ ...revokeIntent, fees })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toMatchObject({
      name: 'IntentPolicyViolationError',
      retryable: false
    })
    expect(chainId).not.toHaveBeenCalled()
    expect(pendingNonce).not.toHaveBeenCalled()
    expect(getPublicKey).not.toHaveBeenCalled()
    const denied = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(event => event.event === 'middleware.intent_denied')
    expect(denied).toMatchObject({ check: 'nonce-pin', field: 'operation.nonce' })
  })

  it('records the kms_sign line even when the Sign response fails the recovery check', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    stubRpc()
    // The Sign call completes — a CloudTrail event exists — but the signature recovers to the
    // wrong key, so the per-artifact record must still land alongside the kms_error denial.
    const foreignSecret = hexToBytes(`0x${'22'.repeat(32)}`)
    const handle = createHandler({
      kms: fakeKms(undefined, async (_config, digestBytes) => ({
        signature: secp256k1.sign(digestBytes, foreignSecret, { lowS: false }).toDERRawBytes(),
        kmsRequestId: 'kms-req-foreign'
      })),
      chainRead: chainReadFake()
    })

    const response = await handle(revokeIntent, { awsRequestId: 'req-v' })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial.name).toBe('KmsSigningFailedError')
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toContainEqual({
      event: 'middleware.kms_sign',
      intentKind: 'revoke',
      awsRequestId: 'req-v',
      digest: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      kmsRequestId: 'kms-req-foreign'
    })
    expect(events).toContainEqual({
      event: 'middleware.kms_error',
      intentKind: 'revoke',
      awsRequestId: 'req-v',
      reason: 'recovery'
    })
  })

  it('approves an ecrecover quote with the re-derived root, one Sign call, and the publication', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    const { maturity, offers, tree } = buildOfferFixture()
    stubPolicy({ surface: 'quote', markets: [fixtureMarketEntry({ maturity })] })
    stubKms()
    const signDigest = vi.fn<KmsTransport['signDigest']>(async (_config, digestBytes) => ({
      signature: secp256k1.sign(digestBytes, secret, { lowS: false }).toDERRawBytes(),
      kmsRequestId: 'kms-req-sign'
    }))
    const handle = createHandler({ kms: fakeKms(undefined, signDigest) })

    const response = await handle(
      {
        contractVersion: 1,
        kind: 'quote',
        chainId: 8453,
        maker,
        idempotencyKey: 'quote-1',
        offers
      },
      { awsRequestId: 'req-q' }
    )

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'quote') throw new Error('unreachable')
    expect(response.result.root).toBe(tree.root)
    const digest = EcrecoverRatifierUtils.digest({ tree, chainId: 8453n })
    await expect(
      recoverAddress({ hash: digest, signature: response.result.treeSignature })
    ).resolves.toBe(maker)
    // Exactly one kms:Sign call for an approved Ecrecover quote (TIB Observability).
    expect(signDigest).toHaveBeenCalledTimes(1)
    expect(response.result.publication.to).toBe(FIXTURE_MEMPOOL)
    expect(response.result.publication.value).toBe('0')
    const items = await Payload.decode(response.result.publication.data)
    expect(items).toHaveLength(1)
    const verified = await EcrecoverRatifierUtils.verifyRatifierData({
      chainId: 8453n,
      offer: items[0]!.offer,
      ratifierData: items[0]!.ratifierData
    })
    expect(verified.signer).toBe(maker)
    expect(verified.root).toBe(tree.root)
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toStrictEqual([
      { event: 'middleware.intent_received', intentKind: 'quote', awsRequestId: 'req-q' },
      {
        event: 'middleware.kms_sign',
        intentKind: 'quote',
        awsRequestId: 'req-q',
        digest,
        kmsRequestId: 'kms-req-sign'
      },
      {
        event: 'middleware.intent_approved',
        intentKind: 'quote',
        awsRequestId: 'req-q',
        root: tree.root,
        kmsSignCalls: 1
      }
    ])
  })

  it('approves a setter ratification with the signed root approval and the publication', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { maturity, offers, tree } = buildOfferFixture()
    stubPolicy({
      surface: 'ratify',
      ratifierMode: 'setter',
      markets: [fixtureMarketEntry({ maturity })]
    })
    stubKms()
    stubRpc()
    const handle = createHandler({ kms: fakeKms(), chainRead: chainReadFake() })

    const response = await handle({
      contractVersion: 1,
      kind: 'ratify',
      chainId: 8453,
      maker,
      idempotencyKey: 'ratify-1',
      offers,
      fees: revokeIntent.fees
    })

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'ratify') throw new Error('unreachable')
    expect(response.result.root).toBe(tree.root)
    const artifact = response.result.transaction
    expect(artifact.nonce).toBe(7)
    await expect(
      recoverTransactionAddress({
        serializedTransaction: artifact.signedTransaction as TransactionSerializedEIP1559
      })
    ).resolves.toBe(maker)
    const parsed = parseTransaction(artifact.signedTransaction)
    expect(getAddress(parsed.to!)).toBe(FIXTURE_RATIFIER)
    expect(decodeFunctionData({ abi: setterRatifierAbi, data: parsed.data! })).toStrictEqual({
      functionName: 'setIsRootRatified',
      args: [maker, tree.root, true]
    })
    expect(response.result.publication.to).toBe(FIXTURE_MEMPOOL)
    await expect(Payload.decode(response.result.publication.data)).resolves.toHaveLength(1)
  })

  it('approves a setup remediation as the exact pinned approval with audit lines', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'setup-remediation' })
    stubKms()
    stubRpc()
    const allowance = vi.fn(async () => 123n)
    const handle = createHandler({ kms: fakeKms(), chainRead: chainReadFake({ allowance }) })

    const response = await handle(remediationIntent, { awsRequestId: 'req-r' })

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'setup-remediation') {
      throw new Error('unreachable')
    }
    const artifact = response.result.transaction
    expect(artifact.nonce).toBe(7)
    expect(allowance).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      token: FIXTURE_LOAN_TOKEN,
      owner: maker,
      spender: fixtureRemediationAction.spender
    })
    await expect(
      recoverTransactionAddress({
        serializedTransaction: artifact.signedTransaction as TransactionSerializedEIP1559
      })
    ).resolves.toBe(maker)
    const parsed = parseTransaction(artifact.signedTransaction)
    expect(getAddress(parsed.to!)).toBe(FIXTURE_LOAN_TOKEN)
    expect(decodeFunctionData({ abi: erc20Abi, data: parsed.data! })).toStrictEqual({
      functionName: 'approve',
      args: [getAddress(fixtureRemediationAction.spender), BigInt(fixtureRemediationAction.amount)]
    })
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toStrictEqual([
      {
        event: 'middleware.intent_received',
        intentKind: 'setup-remediation',
        awsRequestId: 'req-r'
      },
      {
        event: 'middleware.kms_sign',
        intentKind: 'setup-remediation',
        awsRequestId: 'req-r',
        digest: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        kmsRequestId: 'kms-req-sign'
      },
      {
        event: 'middleware.intent_approved',
        intentKind: 'setup-remediation',
        awsRequestId: 'req-r',
        remediation: 'loan-asset-approval',
        nonce: 7,
        transactionHash: artifact.hash,
        kmsSignCalls: 1
      }
    ])
  })

  it('denies a remediation whose pinned allowance already holds, with no kms traffic', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'setup-remediation' })
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const pendingNonce = vi.fn(async () => 7)
    const allowance = vi.fn(async () => BigInt(fixtureRemediationAction.amount))
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake({ allowance, pendingNonce }),
      attestAtStartup: false
    })

    const response = await handle(remediationIntent)

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toMatchObject({
      name: 'IntentPolicyViolationError',
      retryable: false
    })
    expect(getPublicKey).not.toHaveBeenCalled()
    expect(pendingNonce).not.toHaveBeenCalled()
    const denied = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(event => event.event === 'middleware.intent_denied')
    expect(denied).toMatchObject({ check: 'remediation-state', field: 'remediation' })
  })

  it('denies retryably with read_failed and no kms traffic when the allowance read fails', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'setup-remediation' })
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const allowance = vi.fn(async () => {
      throw new Error('execution reverted')
    })
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake({ allowance }),
      attestAtStartup: false
    })

    const response = await handle(remediationIntent)

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toMatchObject({
      name: 'RpcUnavailableError',
      retryable: true
    })
    expect(getPublicKey).not.toHaveBeenCalled()
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.find(event => event.event === 'middleware.read_failed')).toMatchObject({
      intentKind: 'setup-remediation',
      operation: 'allowance'
    })
  })

  it('approves a break-glass self-cancel inside the live nonce window with audit lines', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'break-glass-revoke' })
    stubKms()
    stubRpc()
    const handle = createHandler({ kms: fakeKms(), chainRead: chainReadFake() })

    const response = await handle(
      { ...revokeIntent, operation: { type: 'self-cancel', nonce: 5 } },
      { awsRequestId: 'req-s' }
    )

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'revoke') throw new Error('unreachable')
    const artifact = response.result.transaction
    expect(artifact.nonce).toBe(5)
    await expect(
      recoverTransactionAddress({
        serializedTransaction: artifact.signedTransaction as TransactionSerializedEIP1559
      })
    ).resolves.toBe(maker)
    const parsed = parseTransaction(artifact.signedTransaction)
    expect(getAddress(parsed.to!)).toBe(maker)
    expect(parsed.data ?? '0x').toBe('0x')
    expect(parsed.value ?? 0n).toBe(0n)
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toStrictEqual([
      { event: 'middleware.intent_received', intentKind: 'revoke', awsRequestId: 'req-s' },
      {
        event: 'middleware.kms_sign',
        intentKind: 'revoke',
        awsRequestId: 'req-s',
        digest: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        kmsRequestId: 'kms-req-sign'
      },
      {
        event: 'middleware.intent_approved',
        intentKind: 'revoke',
        awsRequestId: 'req-s',
        operation: 'self-cancel',
        nonce: 5,
        transactionHash: artifact.hash,
        kmsSignCalls: 1
      }
    ])
  })

  it.each<[string, number, number, number]>([
    ['at exactly the pending count', 7, 5, 7],
    ['inside an empty window where nothing is in flight', 5, 5, 5]
  ])('approves a break-glass self-cancel %s', async (_description, nonce, latest, pending) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy({ surface: 'break-glass-revoke' })
    stubKms()
    stubRpc()
    const handle = createHandler({
      kms: fakeKms(),
      chainRead: chainReadFake({
        latestNonce: async () => latest,
        pendingNonce: async () => pending
      }),
      attestAtStartup: false
    })

    const response = await handle({ ...revokeIntent, operation: { type: 'self-cancel', nonce } })

    expect(response.approved).toBe(true)
    if (!response.approved || response.result.kind !== 'revoke') throw new Error('unreachable')
    expect(response.result.transaction.nonce).toBe(nonce)
  })

  it('denies retryably before kms when the window moves between the two nonce reads', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'break-glass-revoke' })
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      // Transactions mined between the reads: pending reads 7, then latest reads 8.
      chainRead: chainReadFake({ pendingNonce: async () => 7, latestNonce: async () => 8 }),
      attestAtStartup: false
    })

    const response = await handle({ ...revokeIntent, operation: { type: 'self-cancel', nonce: 7 } })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toMatchObject({
      name: 'RpcUnavailableError',
      retryable: true
    })
    expect(getPublicKey).not.toHaveBeenCalled()
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.find(event => event.event === 'middleware.read_failed')).toMatchObject({
      intentKind: 'revoke',
      operation: 'latest-nonce'
    })
  })

  it.each<[string, number]>([
    ['below the latest count', 4],
    ['above the pending count', 8]
  ])('denies a self-cancel %s with no kms traffic', async (_description, nonce) => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy({ surface: 'break-glass-revoke' })
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake(),
      attestAtStartup: false
    })

    const response = await handle({ ...revokeIntent, operation: { type: 'self-cancel', nonce } })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toMatchObject({
      name: 'IntentPolicyViolationError',
      retryable: false
    })
    expect(getPublicKey).not.toHaveBeenCalled()
    const denied = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(event => event.event === 'middleware.intent_denied')
    expect(denied).toMatchObject({ check: 'nonce-window', field: 'operation.nonce' })
  })

  it.each<[string, Record<string, unknown>]>([
    [
      'a root cancellation carrying a nonce',
      { type: 'cancel-root', root: `0x${'77'.repeat(32)}`, nonce: 7 }
    ],
    ['a self-cancel', { type: 'self-cancel', nonce: 6 }]
  ])('denies %s on the routine surface before any read', async (_description, operation) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const chainId = vi.fn(async () => 8453)
    const latestNonce = vi.fn(async () => 5)
    const pendingNonce = vi.fn(async () => 7)
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake({ chainId, latestNonce, pendingNonce }),
      attestAtStartup: false
    })

    const response = await handle({ ...revokeIntent, operation })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toMatchObject({
      name: 'IntentPolicyViolationError',
      retryable: false
    })
    expect(chainId).not.toHaveBeenCalled()
    expect(latestNonce).not.toHaveBeenCalled()
    expect(pendingNonce).not.toHaveBeenCalled()
    expect(getPublicKey).not.toHaveBeenCalled()
  })

  it('denies a transaction intent with rpc-not-configured when the endpoint is unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    vi.stubEnv('QUOTER_SIGNER_RPC_URL', undefined)
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey), attestAtStartup: false })

    const response = await handle(revokeIntent)

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'RpcNotConfiguredError',
      message: 'invalid quoter-signer rpc configuration: QUOTER_SIGNER_RPC_URL missing',
      retryable: false
    })
    expect(getPublicKey).not.toHaveBeenCalled()
  })

  it('denies retryably with read_failed and no kms traffic when the nonce read fails', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const signDigest = vi.fn<KmsTransport['signDigest']>()
    const handle = createHandler({
      kms: fakeKms(getPublicKey, signDigest),
      chainRead: chainReadFake({
        pendingNonce: async () => {
          throw new Error('socket hang up')
        }
      }),
      attestAtStartup: false
    })

    const response = await handle(revokeIntent, { awsRequestId: 'req-r' })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'RpcUnavailableError',
      message: 'quoter-signer pending-nonce read failed',
      retryable: true
    })
    expect(getPublicKey).not.toHaveBeenCalled()
    expect(signDigest).not.toHaveBeenCalled()
    expect(lines.map(line => JSON.parse(line))).toContainEqual({
      event: 'middleware.read_failed',
      intentKind: 'revoke',
      awsRequestId: 'req-r',
      operation: 'pending-nonce'
    })
  })

  it('denies terminally with read_failed when the endpoint serves another chain', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    stubRpc()
    const handle = createHandler({
      kms: fakeKms(),
      chainRead: chainReadFake({ chainId: async () => 1 }),
      attestAtStartup: false
    })

    const response = await handle(revokeIntent, { awsRequestId: 'req-c' })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'RpcChainMismatchError',
      message: 'quoter-signer rpc endpoint serves a different chain than the policy pin',
      retryable: false
    })
    expect(lines.map(line => JSON.parse(line))).toContainEqual({
      event: 'middleware.read_failed',
      intentKind: 'revoke',
      awsRequestId: 'req-c',
      operation: 'chain-id',
      reason: 'chain-mismatch'
    })
  })

  it('re-denies when the offer set would expire inside the pre-sign lifetime margin', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { maturity, offers } = buildOfferFixture()
    stubPolicy({ surface: 'quote', markets: [fixtureMarketEntry({ maturity })] })
    stubKms()
    const baseMs = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(baseMs)
    const signDigest = vi.fn<KmsTransport['signDigest']>()
    const handle = createHandler({
      kms: {
        getPublicKey: async () => {
          // The attestation await is where wall-clock time passes: land 29s BEFORE the offer
          // expiry (base + 1800s), inside the 30s signing/delivery margin — only the margin-aware
          // recheck between attestation and Sign can catch it.
          clock.mockReturnValue(baseMs + 1_771_000)
          return publicKeyMaterial()
        },
        signDigest
      },
      attestAtStartup: false
    })

    const response = await handle({
      contractVersion: 1,
      kind: 'quote',
      chainId: 8453,
      maker,
      idempotencyKey: 'quote-3',
      offers
    })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'IntentPolicyViolationError',
      message: 'quoter-signer policy denied intent: offers[0].expiry failed offer-expired',
      retryable: false
    })
    expect(signDigest).not.toHaveBeenCalled()
  })

  it('denies a quote whose declared group does not re-derive, with no kms traffic', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { maturity, offers } = buildOfferFixture()
    stubPolicy({ surface: 'quote', markets: [fixtureMarketEntry({ maturity })] })
    stubKms()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const signDigest = vi.fn<KmsTransport['signDigest']>()
    const handle = createHandler({
      kms: fakeKms(getPublicKey, signDigest),
      attestAtStartup: false
    })

    const response = await handle({
      contractVersion: 1,
      kind: 'quote',
      chainId: 8453,
      maker,
      idempotencyKey: 'quote-2',
      offers: [{ ...offers[0]!, group: `0x${'99'.repeat(32)}` }]
    })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'IntentPolicyViolationError',
      message: 'quoter-signer policy denied intent: offers[0].group failed group-derivation',
      retryable: false
    })
    expect(getPublicKey).not.toHaveBeenCalled()
    expect(signDigest).not.toHaveBeenCalled()
  })

  it('denies with sign-outcome-unknown and the kms_error line when the Sign call fails', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    stubRpc()
    const handle = createHandler({
      kms: fakeKms(undefined, async () => {
        throw new Error('socket hang up')
      }),
      chainRead: chainReadFake()
    })

    const response = await handle(revokeIntent, { awsRequestId: 'req-s' })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial).toStrictEqual({
      name: 'KmsSignOutcomeUnknownError',
      message:
        'quoter-signer kms sign call failed with unknown outcome; a signature may exist and blind retry is unsafe',
      retryable: false
    })
    expect(lines.map(line => JSON.parse(line))).toContainEqual({
      event: 'middleware.kms_error',
      intentKind: 'revoke',
      awsRequestId: 'req-s',
      reason: 'sign-outcome-unknown'
    })
  })

  it('attests the maker key once per execution environment across approvals', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey), chainRead: chainReadFake() })

    const first = await handle(revokeIntent)
    const second = await handle(revokeIntent)

    expect(first.approved).toBe(true)
    expect(second.approved).toBe(true)
    expect(getPublicKey).toHaveBeenCalledTimes(1)
  })

  it('denies custody drift with attestation-failed and emits the kms_error line', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    stubPolicy()
    stubKms()
    stubRpc()
    // The configured key answers with another maker's public key: custody drift, fail closed.
    const handle = createHandler({
      kms: fakeKms(async () => publicKeyMaterial({ publicKey: spkiFor(`0x${'22'.repeat(32)}`) })),
      chainRead: chainReadFake()
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
    stubRpc()
    const getPublicKey = vi
      .fn<KmsTransport['getPublicKey']>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(publicKeyMaterial())
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake(),
      attestAtStartup: false
    })

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
    expect(recovered.approved).toBe(true)
    expect(getPublicKey).toHaveBeenCalledTimes(2)
    expect(lines.map(line => JSON.parse(line))).toContainEqual({
      event: 'middleware.kms_error',
      intentKind: 'revoke',
      awsRequestId: 'req-4',
      operation: 'get-public-key'
    })
  })

  it('attests at cold start, before the first invocation, when fully configured', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    stubRpc()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())

    const handle = createHandler({ kms: fakeKms(getPublicKey), chainRead: chainReadFake() })

    // The warm-up runs at construction with no invocation having arrived yet.
    expect(getPublicKey).toHaveBeenCalledExactlyOnceWith({
      keyId: 'alias/quoter-signer-maker',
      region: 'eu-west-1'
    })
    const response = await handle(revokeIntent)
    expect(response.approved).toBe(true)
    expect(getPublicKey).toHaveBeenCalledTimes(1)
  })

  it('serves wire-contract denials while the cold-start attestation is still pending', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    // An attestation that never settles must not block non-signing serving: fail-closed answers
    // to malformed payloads do not wait on custody.
    const handle = createHandler({
      kms: fakeKms(() => new Promise<never>(() => {}))
    })

    const response = await handle({ kind: 'quote' })

    expect(response.approved).toBe(false)
    expect(!response.approved && response.denial.name).toBe('MalformedIntentError')
  })

  it('re-proves a stale attestation and fails closed on key drift past the window', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    stubRpc()
    const startMs = 1_756_200_000_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(startMs)
    // Fresh key first; after the freshness window the same alias resolves to another maker's key.
    const getPublicKey = vi
      .fn<KmsTransport['getPublicKey']>()
      .mockResolvedValueOnce(publicKeyMaterial())
      .mockResolvedValue(publicKeyMaterial({ publicKey: spkiFor(`0x${'22'.repeat(32)}`) }))
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake(),
      attestAtStartup: false
    })

    const fresh = await handle(revokeIntent)
    const reused = await handle(revokeIntent)
    now.mockReturnValue(startMs + KMS_ATTESTATION_FRESHNESS_MS)
    const drifted = await handle(revokeIntent)

    expect(fresh.approved).toBe(true)
    expect(reused.approved).toBe(true)
    expect(!drifted.approved && drifted.denial.name).toBe('KmsAttestationFailedError')
    expect(getPublicKey).toHaveBeenCalledTimes(2)
  })

  it('re-attests after custody drift so a fixed deployment recovers without a restart', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy()
    stubKms()
    stubRpc()
    // First read shows another maker's key (terminal drift); the operator then fixes the key
    // deployment, so the next invocation on the same warm container must re-attest and pass.
    const getPublicKey = vi
      .fn<KmsTransport['getPublicKey']>()
      .mockResolvedValueOnce(publicKeyMaterial({ publicKey: spkiFor(`0x${'22'.repeat(32)}`) }))
      .mockResolvedValue(publicKeyMaterial())
    const handle = createHandler({
      kms: fakeKms(getPublicKey),
      chainRead: chainReadFake(),
      attestAtStartup: false
    })

    const drifted = await handle(revokeIntent)
    const recovered = await handle(revokeIntent)

    expect(!drifted.approved && drifted.denial.name).toBe('KmsAttestationFailedError')
    expect(recovered.approved).toBe(true)
    expect(getPublicKey).toHaveBeenCalledTimes(2)
  })

  it('never calls kms for malformed or out-of-policy intents', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubPolicy({ surface: 'quote' })
    stubKms()
    const getPublicKey = vi.fn(async () => publicKeyMaterial())
    const handle = createHandler({ kms: fakeKms(getPublicKey), attestAtStartup: false })

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
