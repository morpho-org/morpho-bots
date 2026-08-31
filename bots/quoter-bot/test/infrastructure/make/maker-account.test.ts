import type { TransactionSerializedLegacy } from 'viem'

import { Wallet } from '@ethereumjs/wallet'
import { secp256k1 } from '@noble/curves/secp256k1'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  recoverAddress,
  recoverTransactionAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vitest'

import { createMakerAccount } from '../../../src/infrastructure/make/maker-account.utils'
import { MiddlewareSigningUnsupportedError } from '../../../src/infrastructure/make/middleware-signing-unsupported.error'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address

describe('maker signer selection', () => {
  test('reuses one AWS KMS client per region across public-key and signing calls', async () => {
    const source = await readFile(
      new URL('../../../src/infrastructure/make/maker-account.utils.ts', import.meta.url),
      'utf8'
    )

    expect(source).toContain('const kmsClients = new Map<string, KMSClient>()')
    expect(source.match(/new KMSClient/g)).toHaveLength(1)
  })

  test('fails closed for the middleware identity instead of exposing a generic signer', async () => {
    await expect(
      createMakerAccount({
        readOnly: false,
        maker,
        method: 'middleware',
        functionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:quoter-signer-routine:prod',
        region: 'eu-west-1'
      })
    ).rejects.toBeInstanceOf(MiddlewareSigningUnsupportedError)
  })

  test('creates the legacy local private-key signer', async () => {
    const account = await createMakerAccount({
      readOnly: false,
      maker,
      method: 'private-key',
      privateKey
    })
    expect(account.address).toBe(maker)
    expect(
      await recoverAddress({
        hash: hashMessage('legacy'),
        signature: await account.signMessage({ message: 'legacy' })
      })
    ).toBe(maker)
  })

  test('rejects a local private key that does not derive the configured maker', async () => {
    const wrongMaker = privateKeyToAccount(`0x${'22'.repeat(32)}`).address

    await expect(
      createMakerAccount({
        readOnly: false,
        maker: wrongMaker,
        method: 'private-key',
        privateKey
      })
    ).rejects.toMatchObject({ operation: 'maker-address' })
  })

  test('decrypts a keystore only at the signer boundary', async () => {
    const password = '  keystore-秘密🔐  '
    const readFile = vi.fn(async () => '{"encrypted":true}')
    const decryptKeystore = vi.fn(async (json: string, suppliedPassword: string) => {
      expect(json).toContain('encrypted')
      expect(suppliedPassword).toBe(password)
      return privateKey
    })
    const account = await createMakerAccount(
      { readOnly: false, maker, method: 'keystore', path: '/secure/maker.json', password },
      { readFile, decryptKeystore }
    )
    expect(account.address).toBe(maker)
    expect(readFile).toHaveBeenCalledWith('/secure/maker.json')
    expect(decryptKeystore).toHaveBeenCalledTimes(1)
  })

  test('rejects a decrypted keystore that does not derive the configured maker', async () => {
    const wrongMaker = privateKeyToAccount(`0x${'22'.repeat(32)}`).address

    await expect(
      createMakerAccount(
        {
          readOnly: false,
          maker: wrongMaker,
          method: 'keystore',
          path: '/secure/maker.json',
          password: 'not-reported'
        },
        { readFile: async () => '{}', decryptKeystore: async () => privateKey }
      )
    ).rejects.toMatchObject({ operation: 'maker-address' })
  })

  test('decrypts and signs with a real Web3 Secret Storage keystore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quoter-keystore-'))
    const path = join(directory, 'maker.json')
    const password = '  actual-keystore-秘密🔐  '
    try {
      const wallet = Wallet.fromPrivateKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')))
      await writeFile(path, await wallet.toV3String(password))
      const account = await createMakerAccount({
        readOnly: false,
        maker,
        method: 'keystore',
        path,
        password
      })
      const signature = await account.signMessage({ message: 'real keystore' })
      expect(await recoverAddress({ hash: hashMessage('real keystore'), signature })).toBe(maker)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('uses AWS KMS for non-exportable remote signing and recovers the configured maker', async () => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const getPublicKey = vi.fn(async () => spki)
    const signDigest = vi.fn(async (_keyId: string, _region: string, digest: Uint8Array) =>
      secp256k1.sign(digest, secret, { lowS: false }).toDERRawBytes()
    )
    const account = await createMakerAccount(
      {
        readOnly: false,
        maker,
        method: 'aws',
        keyId: 'alias/quoter',
        region: 'eu-west-1'
      },
      { kms: { getPublicKey, signDigest } }
    )
    const message = 'kms remote signing'
    const signature = await account.signMessage({ message })
    expect(await recoverAddress({ hash: hashMessage(message), signature })).toBe(maker)
    const transaction = await account.signTransaction({
      chainId: 8453,
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      nonce: 0,
      to: maker,
      type: 'eip1559',
      value: 1n
    })
    expect(
      await recoverTransactionAddress({ serializedTransaction: transaction as `0x02${string}` })
    ).toBe(maker)
    expect(getPublicKey).toHaveBeenCalledWith('alias/quoter', 'eu-west-1')
    expect(signDigest).toHaveBeenCalledWith(
      'alias/quoter',
      'eu-west-1',
      Uint8Array.from(Buffer.from(hashMessage(message).slice(2), 'hex'))
    )
    expect(bytesToHex(publicKey)).not.toBe(privateKey)
  })

  test('AWS KMS signs typed data plus legacy and EIP-2930 transactions', async () => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const account = await createMakerAccount(
      { readOnly: false, maker, method: 'aws', keyId: 'alias/maker', region: 'eu-west-1' },
      {
        kms: {
          getPublicKey: async () => spki,
          signDigest: async (_keyId, _region, digest) =>
            secp256k1.sign(digest, secret, { lowS: false }).toDERRawBytes()
        }
      }
    )
    const typedData = {
      domain: { name: 'Market Maker', version: '1', chainId: 8453 },
      types: { Order: [{ name: 'maker', type: 'address' }] },
      primaryType: 'Order' as const,
      message: { maker }
    }
    const typedSignature = await account.signTypedData(typedData)
    expect(
      await recoverAddress({ hash: hashTypedData(typedData), signature: typedSignature })
    ).toBe(maker)

    const legacy = await account.signTransaction({
      chainId: 8453,
      gas: 21_000n,
      gasPrice: 1n,
      nonce: 0,
      to: maker,
      type: 'legacy',
      value: 1n
    })
    expect(
      await recoverTransactionAddress({
        serializedTransaction: legacy as TransactionSerializedLegacy
      })
    ).toBe(maker)

    const eip2930 = await account.signTransaction({
      accessList: [],
      chainId: 8453,
      gas: 21_000n,
      gasPrice: 1n,
      nonce: 0,
      to: maker,
      type: 'eip2930',
      value: 1n
    })
    expect(
      await recoverTransactionAddress({ serializedTransaction: eip2930 as `0x01${string}` })
    ).toBe(maker)
  })

  test('AWS KMS normalizes high-s signatures before recovery', async () => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const account = await createMakerAccount(
      { readOnly: false, maker, method: 'aws', keyId: 'alias/maker', region: 'eu-west-1' },
      {
        kms: {
          getPublicKey: async () => spki,
          signDigest: async (_keyId, _region, digest) => {
            const signature = secp256k1.sign(digest, secret, { lowS: true })
            return new secp256k1.Signature(
              signature.r,
              secp256k1.CURVE.n - signature.s
            ).toDERRawBytes()
          }
        }
      }
    )
    const signature = await account.signMessage({ message: 'normalize high s' })
    expect(await recoverAddress({ hash: hashMessage('normalize high s'), signature })).toBe(maker)
  })

  test.each([
    ['truncated SPKI', '3056301006072a8648ce3d020106052b8104000a03420004'],
    [
      'BER indefinite-length SPKI',
      `3080301006072a8648ce3d020106052b8104000a034200${Buffer.from(
        secp256k1.getPublicKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')), false)
      ).toString('hex')}0000`
    ],
    [
      'wrong P-256 curve',
      `3059301306072a8648ce3d020106082a8648ce3d030107034200${Buffer.from(
        secp256k1.getPublicKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')), false)
      ).toString('hex')}`
    ],
    [
      'trailing data',
      `3056301006072a8648ce3d020106052b8104000a034200${Buffer.from(
        secp256k1.getPublicKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')), false)
      ).toString('hex')}00`
    ],
    [
      'trailing SPKI field',
      `3058301006072a8648ce3d020106052b8104000a034200${Buffer.from(
        secp256k1.getPublicKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')), false)
      ).toString('hex')}0500`
    ],
    [
      'compressed point',
      `3036301006072a8648ce3d020106052b8104000a032200${Buffer.from(
        secp256k1.getPublicKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')), true)
      ).toString('hex')}`
    ]
  ])('rejects malformed or unsupported AWS KMS SPKI: %s', async (_name, spkiHex) => {
    await expect(
      createMakerAccount(
        { readOnly: false, maker, method: 'aws', keyId: 'alias/maker', region: 'eu-west-1' },
        {
          kms: {
            getPublicKey: async () => Buffer.from(spkiHex, 'hex'),
            signDigest: async () => new Uint8Array()
          }
        }
      )
    ).rejects.toMatchObject({ operation: 'kms-public-key' })
  })

  test.each([
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
      `3026022100fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141020101`
    ],
    [
      's at curve order',
      `3026020101022100fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`
    ],
    ['unrecoverable canonical integers', '3006020101020101']
  ])('rejects malformed or non-canonical AWS KMS DER: %s', async (_name, derHex) => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const account = await createMakerAccount(
      { readOnly: false, maker, method: 'aws', keyId: 'alias/maker', region: 'eu-west-1' },
      {
        kms: { getPublicKey: async () => spki, signDigest: async () => Buffer.from(derHex, 'hex') }
      }
    )
    await expect(account.signMessage({ message: 'reject malformed der' })).rejects.toMatchObject({
      operation: 'kms-sign'
    })
  })

  test('rejects an AWS KMS signature that cannot recover the configured maker', async () => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const wrongSecret = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const account = await createMakerAccount(
      { readOnly: false, maker, method: 'aws', keyId: 'alias/maker', region: 'eu-west-1' },
      {
        kms: {
          getPublicKey: async () => spki,
          signDigest: async (_keyId, _region, digest) =>
            secp256k1.sign(digest, wrongSecret, { lowS: false }).toDERRawBytes()
        }
      }
    )
    await expect(account.signMessage({ message: 'wrong signer' })).rejects.toMatchObject({
      operation: 'kms-sign'
    })
  })
})
