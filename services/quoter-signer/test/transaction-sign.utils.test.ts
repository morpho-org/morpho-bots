import type { TransactionSerializedEIP1559 } from 'viem'

import { secp256k1 } from '@noble/curves/secp256k1'
import {
  getAddress,
  hexToBytes,
  keccak256,
  parseTransaction,
  recoverTransactionAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import type { ArtifactEncodingStage } from '../src/artifact-encoding-failed.error'
import type { KmsMakerSigner } from '../src/kms-signer.utils'
import type { MakerTransaction, MakerTransactionRequest } from '../src/transaction-sign.utils'

import { createKmsMakerSigner } from '../src/kms-signer.utils'
import {
  assembleSignedTransaction,
  buildMakerTransaction,
  deriveMakerTransactionDigest
} from '../src/transaction-sign.utils'
import { FIXTURE_MIDNIGHT } from './policy-fixture'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address
const secret = hexToBytes(privateKey)

const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200'
const spki = hexToBytes(
  `0x${SPKI_PREFIX}${Buffer.from(secp256k1.getPublicKey(secret, false)).toString('hex')}`
)

/** Real attested signer over a fake KMS transport producing genuine DER secp256k1 signatures. */
const signerPromise: Promise<KmsMakerSigner> = createKmsMakerSigner(
  { keyId: 'alias/test', region: 'eu-west-1' },
  maker,
  {
    getPublicKey: async () => ({
      publicKey: spki,
      keyArn: 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
      keySpec: 'ECC_SECG_P256K1',
      keyUsage: 'SIGN_VERIFY',
      signingAlgorithms: ['ECDSA_SHA_256']
    }),
    signDigest: async (_config, digestBytes) => ({
      signature: secp256k1.sign(digestBytes, secret, { lowS: false }).toDERRawBytes(),
      kmsRequestId: 'kms-req-1'
    })
  }
)

const fees = { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', gas: '90000' }

const request = {
  chainId: 8453,
  nonce: 7,
  call: { to: FIXTURE_MIDNIGHT, data: '0x12345678' },
  fees
} as const satisfies MakerTransactionRequest

describe('buildMakerTransaction', () => {
  it('pins the eip1559 envelope with zero value and the exact request fields', () => {
    const expected: MakerTransaction = {
      type: 'eip1559',
      chainId: 8453,
      nonce: 7,
      to: FIXTURE_MIDNIGHT,
      value: 0n,
      data: '0x12345678',
      gas: 90000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n
    }

    expect(buildMakerTransaction(request)).toStrictEqual(expected)
  })
})

describe('assembleSignedTransaction', () => {
  it('produces broadcastable bytes that recover to the maker with the exact fields', async () => {
    const signer = await signerPromise
    const transaction = buildMakerTransaction(request)
    const digest = deriveMakerTransactionDigest(transaction)
    const signed = await signer.signDigest(digest)

    const artifact = assembleSignedTransaction(transaction, fees, signed)

    expect(artifact.nonce).toBe(7)
    expect(artifact.fees).toStrictEqual(fees)
    expect(artifact.hash).toBe(keccak256(artifact.signedTransaction))
    await expect(
      recoverTransactionAddress({
        serializedTransaction: artifact.signedTransaction as TransactionSerializedEIP1559
      })
    ).resolves.toBe(maker)
    const parsed = parseTransaction(artifact.signedTransaction)
    expect(parsed).toMatchObject({
      type: 'eip1559',
      chainId: 8453,
      nonce: 7,
      data: '0x12345678',
      gas: 90000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n
    })
    // viem omits the canonical empty RLP value field when parsing; zero is the only legal value.
    expect(parsed.value ?? 0n).toBe(0n)
    expect(getAddress(parsed.to!)).toBe(FIXTURE_MIDNIGHT)
  })

  it('fails closed with the transaction stage when the signature cannot be parsed', async () => {
    const transaction = buildMakerTransaction(request)
    const stage: ArtifactEncodingStage = 'transaction'

    expect(() =>
      assembleSignedTransaction(transaction, fees, {
        signature: '0x1234',
        kmsRequestId: 'kms-req-2'
      })
    ).toThrowError(
      expect.objectContaining({ name: 'ArtifactEncodingFailedError', stage, retryable: false })
    )
  })
})
