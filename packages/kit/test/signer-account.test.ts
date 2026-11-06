import type { Policy } from '@repo/kit'
import type { TransactionSerializedLegacy } from 'viem'

import { Wallet } from '@ethereumjs/wallet'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  createAccountSigner,
  createKeystoreAccount,
  createKmsAccount,
  EXECUTOR_SELECTOR,
  isValidPrivateKey
} from '@repo/kit'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  numberToHex,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterEach, describe, expect, test, vi } from 'vitest'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address

describe('isValidPrivateKey', () => {
  test.each([
    numberToHex(0n, { size: 32 }),
    numberToHex(1n, { size: 32 }),
    numberToHex(secp256k1.CURVE.n - 1n, { size: 32 }),
    numberToHex(secp256k1.CURVE.n, { size: 32 }),
    numberToHex(2n ** 256n - 1n, { size: 32 }),
    `0x${'1'.repeat(63)}` as const,
    `0x${'11'.repeat(31)}` as const
  ])('agrees with viem on %s', key => {
    const viemAccepts = (() => {
      try {
        privateKeyToAccount(key)
        return true
      } catch {
        return false
      }
    })()
    expect(isValidPrivateKey(key)).toBe(viemAccepts)
  })
})

describe('signer accounts', () => {
  test('reuses one AWS KMS client per region across public-key and signing calls', async () => {
    const source = await readFile(new URL('../src/signer-account.ts', import.meta.url), 'utf8')

    expect(source).toContain('const kmsClients = new Map<string, KMSClient>()')
    expect(source.match(/new KMSClient/g)).toHaveLength(1)
  })

  test('decrypts a keystore only at the signer boundary', async () => {
    const password = '  keystore-秘密🔐  '
    const readFile = vi.fn(async () => '{"encrypted":true}')
    const decryptKeystore = vi.fn(async (json: string, suppliedPassword: string) => {
      expect(json).toContain('encrypted')
      expect(suppliedPassword).toBe(password)
      return privateKey
    })
    const account = await createKeystoreAccount(
      { path: '/secure/maker.json', password },
      { readFile, decryptKeystore }
    )
    expect(account.address).toBe(maker)
    expect(readFile).toHaveBeenCalledWith('/secure/maker.json')
    expect(decryptKeystore).toHaveBeenCalledTimes(1)
  })

  test('reports an unreadable or undecryptable keystore without its contents', async () => {
    await expect(
      createKeystoreAccount(
        { path: '/secure/maker.json', password: 'not-reported' },
        {
          readFile: async () => {
            throw new Error('/secure/maker.json')
          }
        }
      )
    ).rejects.toMatchObject({ operation: 'keystore-read' })
    await expect(
      createKeystoreAccount(
        { path: '/secure/maker.json', password: 'not-reported' },
        { readFile: async () => '{"version":3}' }
      )
    ).rejects.toMatchObject({ operation: 'keystore-decrypt' })
  })

  test('decrypts and signs with a real Web3 Secret Storage keystore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quoter-keystore-'))
    const path = join(directory, 'maker.json')
    const password = '  actual-keystore-秘密🔐  '
    try {
      const wallet = Wallet.fromPrivateKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')))
      await writeFile(path, await wallet.toV3String(password))
      const account = await createKeystoreAccount({ path, password })
      const signature = await account.signMessage({ message: 'real keystore' })
      expect(await recoverAddress({ hash: hashMessage('real keystore'), signature })).toBe(maker)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('uses AWS KMS for non-exportable remote signing and recovers the delegated signer', async () => {
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
    const account = await createKmsAccount(
      { keyId: 'alias/quoter', region: 'eu-west-1' },
      { getPublicKey, signDigest }
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
    const account = await createKmsAccount(
      { keyId: 'alias/maker', region: 'eu-west-1' },
      {
        getPublicKey: async () => spki,
        signDigest: async (_keyId, _region, digest) =>
          secp256k1.sign(digest, secret, { lowS: false }).toDERRawBytes()
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
    const account = await createKmsAccount(
      { keyId: 'alias/maker', region: 'eu-west-1' },
      {
        getPublicKey: async () => spki,
        signDigest: async (_keyId, _region, digest) => {
          const signature = secp256k1.sign(digest, secret, { lowS: true })
          return new secp256k1.Signature(
            signature.r,
            secp256k1.CURVE.n - signature.s
          ).toDERRawBytes()
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
      createKmsAccount(
        { keyId: 'alias/maker', region: 'eu-west-1' },
        {
          getPublicKey: async () => Buffer.from(spkiHex, 'hex'),
          signDigest: async () => new Uint8Array()
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
    const account = await createKmsAccount(
      { keyId: 'alias/maker', region: 'eu-west-1' },
      { getPublicKey: async () => spki, signDigest: async () => Buffer.from(derHex, 'hex') }
    )
    await expect(account.signMessage({ message: 'reject malformed der' })).rejects.toMatchObject({
      operation: 'kms-sign'
    })
  })

  test('rejects an AWS KMS signature that cannot recover the derived signer', async () => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const wrongSecret = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const account = await createKmsAccount(
      { keyId: 'alias/maker', region: 'eu-west-1' },
      {
        getPublicKey: async () => spki,
        signDigest: async (_keyId, _region, digest) =>
          secp256k1.sign(digest, wrongSecret, { lowS: false }).toDERRawBytes()
      }
    )
    await expect(account.signMessage({ message: 'wrong signer' })).rejects.toMatchObject({
      operation: 'kms-sign'
    })
  })
})

describe('kernel nonce authority', () => {
  afterEach(() => vi.restoreAllMocks())

  const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
  const kms = {
    getPublicKey: async () =>
      Uint8Array.from([
        ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
        ...secp256k1.getPublicKey(secret, false)
      ]),
    signDigest: async (_keyId: string, _region: string, digest: Uint8Array) =>
      secp256k1.sign(digest, secret).toDERRawBytes()
  }

  const accounts = {
    'private-key': async () => privateKeyToAccount(privateKey),
    aws: () => createKmsAccount({ keyId: 'alias/quoter', region: 'eu-west-1' }, kms)
  }
  const STALE_NONCE = '0x7'
  const executor = `0x${'33'.repeat(20)}` as const
  const policy: Policy = {
    chainId: base.id,
    targets: [executor],
    maxFeePerGasWei: 10n,
    maxSpendWei: 10n ** 6n,
    maxGasLimit: 100_000n,
    maxDataBytes: 4
  }
  const filled = {
    hash: `0x${'00'.repeat(32)}`,
    type: '0x2',
    chainId: `0x${base.id.toString(16)}`,
    from: maker,
    to: executor,
    input: EXECUTOR_SELECTOR,
    value: '0x0',
    gas: '0x5208',
    maxFeePerGas: '0x2',
    maxPriorityFeePerGas: '0x1',
    nonce: STALE_NONCE
  }

  test.each([
    { method: 'private-key', nonce: 42 },
    { method: 'aws', nonce: 42 },
    { method: 'private-key', nonce: 0 },
    { method: 'aws', nonce: 0 }
  ] as const)(
    'a $method signer signs at exactly the kernel nonce $nonce',
    async ({ method, nonce }) => {
      const methods: string[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation((async (
        _url: unknown,
        init?: RequestInit
      ) => {
        const body = JSON.parse(init?.body as string) as { id: number; method: string }
        methods.push(body.method)
        const result =
          body.method === 'eth_chainId'
            ? `0x${base.id.toString(16)}`
            : body.method === 'eth_fillTransaction'
              ? { raw: '0x', tx: filled }
              : STALE_NONCE
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      }) as typeof fetch)
      const signerAccount = await accounts[method]()
      const signer = createAccountSigner({
        chain: base,
        rpcUrl: 'http://localhost:8545',
        account: signerAccount,
        policy
      })

      const signed = await signer.sign({
        to: executor,
        data: EXECUTOR_SELECTOR,
        value: 0n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        nonce,
        mayAct: () => true
      })

      expect(signerAccount.nonceManager).toBeUndefined()
      expect(methods).toContain('eth_fillTransaction')
      expect(methods).not.toContain('eth_getTransactionCount')
      expect(signed.nonce).toBe(nonce)
      expect(parseTransaction(signed.raw).nonce).toBe(nonce)
    }
  )
})
